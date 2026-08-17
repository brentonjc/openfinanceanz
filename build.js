#!/usr/bin/env node
/* ============================================================
   Open Finance ANZ — static build
   ------------------------------------------------------------
   Turns the single index.html source into one real HTML file per
   route, with content from content/*.json already baked in.

   Why this exists: AI crawlers (GPTBot, ClaudeBot, PerplexityBot,
   OAI-SearchBot) do not execute JavaScript. Before this script,
   every URL returned the same document with the homepage title,
   description and canonical, and the events/partners/gallery
   containers were empty. After it, each URL is a distinct,
   fully-populated document in the raw HTML response.

   Nothing about how the site is authored changes. index.html stays
   the single source of markup, the render functions inside it stay
   the single implementation, and Decap keeps writing to
   content/site.json and content/events.json.

   Usage:  node build.js        -> writes ./dist
   Deps:   none (Node 18+)
   ============================================================ */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'dist');
const SRC = path.join(ROOT, 'index.html');

/* Assets copied verbatim into dist. content/ is included so the
   client-side fetch still works for visitors with JS, which keeps
   CMS edits live-updating in the browser between deploys. */
const ASSETS = [
  'images',
  'content',
  'admin',
  'robots.txt',
  'favicon-32.png',
  'apple-touch-icon.png'
];

const SITE_ORIGIN = 'https://www.openfinanceanz.com';

/* ---------- helpers ---------- */

/* Every failure path in this script is fatal by design.
   A build that exits 0 with a missing page or an empty container deploys
   a broken site to production and looks green while doing it. Loud and
   stopped beats quiet and wrong. */
function fail(message, detail) {
  console.error('\n  BUILD FAILED: ' + message);
  if (detail) console.error('    ' + detail);
  console.error('');
  process.exit(1);
}

function readJSON(rel) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) {
    console.warn('  ! ' + rel + ' not found — using built-in defaults');
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn('  ! ' + rel + ' is not valid JSON — using built-in defaults');
    return null;
  }
}

function getByPath(obj, dotted) {
  return dotted.split('.').reduce(function (acc, key) {
    if (acc === null || acc === undefined) return undefined;
    return acc[key];
  }, obj);
}

function escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeText(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function copyRecursive(from, to) {
  if (!fs.existsSync(from)) return;
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    fs.readdirSync(from).forEach(function (entry) {
      copyRecursive(path.join(from, entry), path.join(to, entry));
    });
  } else {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

/* ---------- 1. read source ---------- */

const html = fs.readFileSync(SRC, 'utf8');
const siteCopy = readJSON('content/site.json');
const eventsData = readJSON('content/events.json') || {};

/* reportPartners lives in site.json (edited under "Website Copy" in the
   CMS), not events.json — but the render bootstrap below reads a single
   __DATA object, so merge it in here rather than threading a second
   source through the sandbox. */
if (siteCopy && Array.isArray(siteCopy.reportPartners)) {
  eventsData.reportPartners = siteCopy.reportPartners;
}

/* ---------- 2. slice the document ---------- */

const SCRIPT_OPEN = '\n  <script>\n';
const SCRIPT_CLOSE = '\n  </script>\n</body>';

const scriptStart = html.indexOf(SCRIPT_OPEN);
const scriptEnd = html.indexOf(SCRIPT_CLOSE);
if (scriptStart === -1 || scriptEnd === -1) {
  throw new Error('Could not locate the main <script> block in index.html');
}

const scriptBody = html.slice(scriptStart + SCRIPT_OPEN.length, scriptEnd);

/* Everything before the first page container: doctype, head, header/nav. */
const firstPageIdx = html.indexOf('\n  <main id="');
const HEAD_AND_NAV = html.slice(0, firstPageIdx);
/* Everything from the script onward: script + closing tags. */
const TAIL = html.slice(scriptStart);

/* Extract each <main id="x" class="page..."> ... matching </main>.
   The page containers are top-level siblings at exactly two-space indent,
   so the matching close is the next line that is exactly "  </main>".
   The class list is matched loosely: a page container can carry extra
   classes without silently dropping out of the build.
   Only one is ever unhidden at a time (the router toggles aria-hidden per
   page), so six sibling <main> elements stay spec-valid — assistive tech
   only recognises the one that isn't hidden. */
function extractPages(source) {
  const pages = {};
  const re = /\n  <main id="([a-zA-Z0-9_-]+)" class="page(?:\s[^"]*)?">\n/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const id = match[1];
    const bodyStart = match.index + match[0].length;
    const closeIdx = source.indexOf('\n  </main>\n', bodyStart);
    if (closeIdx === -1) throw new Error('Unclosed page <main>: ' + id);
    pages[id] = source.slice(bodyStart, closeIdx);
    re.lastIndex = closeIdx;
  }
  return pages;
}

const PAGES = extractPages(html);

/* ---------- 3. read PAGE_META out of the site's own script ---------- */

const metaMatch = scriptBody.match(/const PAGE_META = (\{[\s\S]*?\n    \});/);
if (!metaMatch) throw new Error('Could not read PAGE_META from index.html');
const PAGE_META = vm.runInNewContext('(' + metaMatch[1] + ')');

/* ---------- 4. run the site's render functions to get real markup ----------
   The render functions are pure string builders that write innerHTML into
   five known containers. Running them here — rather than reimplementing
   them — means there is exactly one copy of the markup logic, in
   index.html, and this script can never drift from it. */

function prerenderFragments() {
  const captured = {};

  function stubEl(id) {
    return {
      get innerHTML() { return captured[id] || ''; },
      set innerHTML(v) { captured[id] = v; },
      addEventListener: function () {},
      setAttribute: function () {},
      removeAttribute: function () {},
      classList: { add: function () {}, remove: function () {}, toggle: function () {} },
      scrollIntoView: function () {},
      focus: function () {},
      querySelector: function () { return null; },
      querySelectorAll: function () { return []; },
      dataset: {},
      style: {}
    };
  }

  const documentStub = {
    title: '',
    getElementById: function (id) { return stubEl(id); },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    addEventListener: function () {},
    createElement: function () { return stubEl('tmp'); },
    documentElement: { style: {} },
    body: stubEl('body')
  };

  const sandbox = {
    document: documentStub,
    /* file: protocol makes canFetchContent() false, so the script keeps its
       built-in fallbacks and never attempts a network call during the build. */
    location: { protocol: 'file:', pathname: '/', hash: '', href: 'file:///' },
    history: { pushState: function () {}, replaceState: function () {} },
    navigator: { userAgent: 'build' },
    fetch: function () { return Promise.resolve({ ok: false, json: function () { return {}; } }); },
    setTimeout: function () {},
    clearTimeout: function () {},
    console: { log: function () {}, warn: function () {}, error: function () {} },
    __DATA: eventsData
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = function () {};
  sandbox.window.scrollTo = function () {};
  sandbox.globalThis = sandbox;

  /* Appended in the same lexical scope so it can reach the script's
     top-level `let` bindings and swap in the CMS data before rendering. */
  const bootstrap = `
    ;(function () {
      if (Array.isArray(__DATA.events)) {
        EVENTS = __DATA.events.filter(function (e) { return e && e.title && e.date; });
      }
      if (Array.isArray(__DATA.partners)) {
        EVENT_PARTNERS = __DATA.partners.filter(function (p) { return p && p.name; });
      }
      if (Array.isArray(__DATA.womenGallery)) WOMEN_GALLERY = __DATA.womenGallery;
      if (Array.isArray(__DATA.reportPartners)) {
        REPORT_PARTNERS = __DATA.reportPartners.filter(function (p) { return p && p.name; });
      }
      renderEvents();
      renderEventPartners();
      renderReportPartners();
      renderWomenGallery();
    })();
  `;

  vm.createContext(sandbox);
  try {
    vm.runInContext(scriptBody + bootstrap, sandbox, { timeout: 10000 });
  } catch (err) {
    fail(
      'Pre-render failed: ' + err.message,
      'Continuing would ship empty events/partners/gallery containers —\n' +
      '    the exact state that made this content invisible to AI crawlers.'
    );
  }
  return captured;
}

const FRAGMENTS = prerenderFragments();

/* A partial render is as damaging as none and would otherwise pass unnoticed,
   so the expected containers are asserted rather than assumed. */
const EXPECTED_FRAGMENTS = [
  'events-upcoming',
  'events-past',
  'event-partners',
  'report-partners',
  'women-gallery'
];

const missingFragments = EXPECTED_FRAGMENTS.filter(function (id) {
  return typeof FRAGMENTS[id] !== 'string' || FRAGMENTS[id].trim() === '';
});

if (missingFragments.length) {
  fail(
    'Pre-render produced no markup for: ' + missingFragments.join(', '),
    'These containers would ship empty and their content would be\n' +
    '    invisible to crawlers. Check the render functions in index.html.'
  );
}

/* ---------- 5. bake fragments into the page markup ---------- */

function injectFragments(pageHtml) {
  /* id="..." isn't always the first attribute (e.g. class comes first on
     report-partners/event-partners), so the id is matched via lookahead
     rather than assumed to be adjacent to `<div `. */
  return pageHtml.replace(
    /(<div(?=[^>]*\bid="([a-z-]+)")[^>]*>)<\/div>/g,
    function (whole, openTag, id) {
      const frag = FRAGMENTS[id];
      if (!frag) return whole;
      return openTag + frag + '</div>';
    }
  );
}

/* ---------- 6. bake CMS copy (what applySiteCopy does at runtime) ----------
   The text replace only matches elements holding a single text node, which is
   true of all data-cms elements today. If someone later wraps part of a
   headline in <strong>, the match silently stops firing — and because the
   runtime applySiteCopy still works via textContent, the field would look
   fine in a browser while being wrong for every crawler. So substitutions are
   counted against expectations and a shortfall fails the build. */

const cmsExpected = new Set();
const cmsApplied = new Set();

function applyCms(pageHtml) {
  if (!siteCopy) return pageHtml;

  /* Record every key on this page that has a usable CMS value, so a
     substitution that never fires can be detected afterwards. */
  const keyRe = /\bdata-cms(-src)?="([^"]+)"/g;
  let keyMatch;
  while ((keyMatch = keyRe.exec(pageHtml)) !== null) {
    const value = getByPath(siteCopy, keyMatch[2]);
    if (typeof value === 'string' && value.trim() !== '') {
      cmsExpected.add((keyMatch[1] ? 'src:' : 'text:') + keyMatch[2]);
    }
  }

  /* data-cms -> element text */
  let out = pageHtml.replace(
    /(<([a-z0-9]+)\b[^>]*\bdata-cms="([^"]+)"[^>]*>)([^<]*)(<\/\2>)/gi,
    function (whole, openTag, tag, key, existing, closeTag) {
      const value = getByPath(siteCopy, key);
      if (typeof value !== 'string' || value.trim() === '') return whole;
      cmsApplied.add('text:' + key);
      return openTag + escapeText(value) + closeTag;
    }
  );

  /* data-cms-src -> src attribute */
  out = out.replace(
    /<([a-z0-9]+)\b([^>]*\bdata-cms-src="([^"]+)"[^>]*)>/gi,
    function (whole, tag, attrs, key) {
      const value = getByPath(siteCopy, key);
      if (typeof value !== 'string' || value.trim() === '') return whole;
      const replaced = attrs.replace(/\bsrc="[^"]*"/, 'src="' + escapeAttr(value) + '"');
      cmsApplied.add('src:' + key);
      return '<' + tag + replaced + '>';
    }
  );

  return out;
}

function assertCmsFullyApplied() {
  const missed = Array.from(cmsExpected).filter(function (k) {
    return !cmsApplied.has(k);
  });
  if (missed.length) {
    fail(
      missed.length + ' CMS field(s) had a value but were never applied: ' + missed.join(', '),
      'The element markup no longer matches what build.js can substitute into\n' +
      '    (usually nested tags inside a data-cms element). The site would render\n' +
      '    correctly in a browser and incorrectly for every crawler.'
    );
  }
}

/* ---------- 7. per-page head ---------- */

function applyHead(headHtml, meta) {
  const url = SITE_ORIGIN + meta.path;
  return headHtml
    .replace(/<title>[\s\S]*?<\/title>/, '<title>' + escapeText(meta.title) + '</title>')
    .replace(
      /(<meta name="description" content=")[^"]*(">)/,
      '$1' + escapeAttr(meta.description) + '$2'
    )
    .replace(
      /(<meta property="og:title" content=")[^"]*(">)/,
      '$1' + escapeAttr(meta.title) + '$2'
    )
    .replace(
      /(<meta property="og:description" content=")[^"]*(">)/,
      '$1' + escapeAttr(meta.description) + '$2'
    )
    .replace(
      /(<meta property="og:url" content=")[^"]*(">)/,
      '$1' + escapeAttr(url) + '$2'
    )
    .replace(
      /(<meta name="twitter:title" content=")[^"]*(">)/,
      '$1' + escapeAttr(meta.title) + '$2'
    )
    .replace(
      /(<meta name="twitter:description" content=")[^"]*(">)/,
      '$1' + escapeAttr(meta.description) + '$2'
    )
    .replace(
      /(<link rel="canonical" href=")[^"]*(">)/,
      '$1' + escapeAttr(url) + '$2'
    );
}

/* ---------- 8. neutralise the SPA router ----------
   Each built page contains only its own page div, so the in-page router
   has nothing to switch to. Left alone, clicking a nav link would
   preventDefault and blank the screen. In the built output the links
   navigate natively — real URLs, real documents. Every other behaviour
   in the script (mobile menu, carousels, form, CMS refresh) is untouched. */

function neutraliseRouter(tail) {
  let out = tail;
  let patched = 0;

  const clickHandler = `    document.addEventListener('click', function (event) {
      const link = findPageLink(event.target);
      if (!link) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      showPage(link.dataset.page);
      closeMobileMenu();
    });`;

  const clickReplacement = `    /* BUILD: routing is server-side now. Links navigate natively; we only
       close the mobile menu on the way out. */
    document.addEventListener('click', function (event) {
      const link = findPageLink(event.target);
      if (!link) return;
      closeMobileMenu();
    });`;

  if (out.includes(clickHandler)) {
    out = out.replace(clickHandler, clickReplacement);
    patched++;
  }

  /* Hash rewriting would point links at routes that no longer exist
     as in-page divs. Disable it. */
  const hashNav = `    function useHashNavigation() {
      document.querySelectorAll('a[data-page]').forEach(function (link) {
        link.setAttribute('href', '#/' + link.dataset.page);
      });
    }`;

  const hashReplacement = `    function useHashNavigation() {
      /* BUILD: no-op. Each route is a real document. */
    }`;

  if (out.includes(hashNav)) {
    out = out.replace(hashNav, hashReplacement);
    patched++;
  }

  if (patched < 2) {
    fail(
      'Router neutralisation patched ' + patched + '/2 blocks.',
      'The click handler or useHashNavigation in index.html no longer matches\n' +
      '    what build.js expects. Unpatched, every nav link would blank the page.\n' +
      '    Update the match strings in neutraliseRouter() to match the source.'
    );
  }

  return out;
}

const TAIL_BUILT = neutraliseRouter(TAIL);

/* ---------- 9. extract shared CSS and JS ----------
   Inlining the stylesheet and script in all six documents means a browser
   re-downloads and re-parses ~85KB of identical bytes on every navigation,
   which is the cost in-page routing used to avoid. Hoisting them into two
   content-hashed files means they are fetched once and served from cache
   for every subsequent page.

   Filenames carry a content hash, so they can be cached immutably and a
   change to either file busts the cache automatically. The JSON-LD blocks
   stay inline — they are per-page metadata, not shared assets. */

const crypto = require('crypto');

function hashOf(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 10);
}

const assets = {};

/* --- stylesheet --- */
const styleMatch = HEAD_AND_NAV.match(/\n  <style>\n([\s\S]*?)\n  <\/style>/);
if (!styleMatch) throw new Error('Could not locate the <style> block in index.html');

const cssBody = styleMatch[1];
const cssName = 'site.' + hashOf(cssBody) + '.css';
assets[cssName] = cssBody;

const HEAD_LINKED = HEAD_AND_NAV.replace(
  styleMatch[0],
  '\n  <link rel="stylesheet" href="/assets/' + cssName + '">'
);

/* --- script ---
   The hash is taken over the bytes actually written to the file, not over
   TAIL_BUILT: hashing the wrapper would rename (and needlessly bust the
   immutable cache for) a 30KB asset whenever anything else in the document
   tail changed.

   `defer` keeps execution after parsing, matching the inline block's old
   position at the end of body. */
const tailScriptMatch = TAIL_BUILT.match(/\n  <script>\n([\s\S]*?)\n  <\/script>/);
if (!tailScriptMatch) throw new Error('Could not locate the main <script> block for extraction');

const jsBody = tailScriptMatch[1];
const scriptName = 'site.' + hashOf(jsBody) + '.js';
assets[scriptName] = jsBody;

const TAIL_LINKED = TAIL_BUILT.replace(
  tailScriptMatch[0],
  '\n  <script src="/assets/' + scriptName + '" defer></script>'
);

/* ---------- 10. write ---------- */

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

console.log('\nOpen Finance ANZ — static build\n');

const built = [];

Object.keys(PAGE_META).forEach(function (pageId) {
  const meta = PAGE_META[pageId];
  const pageBody = PAGES[pageId];
  if (pageBody === undefined) {
    fail(
      'No markup found for page "' + pageId + '" (route ' + meta.path + ').',
      'PAGE_META declares this route but no matching <main id="' + pageId + '" class="page">\n' +
      '    exists in index.html. Shipping would leave a linked, sitemapped URL 404ing.'
    );
  }

  const body = applyCms(injectFragments(pageBody));

  const doc =
    applyHead(HEAD_LINKED, meta) +
    '\n  <main id="' + pageId + '" class="page active">\n' +
    body +
    '\n  </main>\n' +
    TAIL_LINKED;

  const outPath =
    meta.path === '/'
      ? path.join(OUT, 'index.html')
      : path.join(OUT, meta.path.replace(/^\//, ''), 'index.html');

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, doc, 'utf8');

  const rel = path.relative(OUT, outPath);
  built.push({ page: pageId, url: meta.path, file: rel, bytes: Buffer.byteLength(doc) });
});

/* 404 — real page, so unknown URLs stop soft-404ing as the homepage.

   The div is deliberately id="home". On an unrecognised path the bundled
   router's pageFromLocation() falls through to 'home', and syncPageVisibility
   then strips .active from every div whose id doesn't match — which, with
   .page { display: none }, would render a blank white screen. Matching the
   fallback id keeps the page visible.

   The canonical tag is removed rather than rewritten: applyPageMeta would
   otherwise point it at "/" on load. Netlify serves this with a real 404
   status and the robots meta is noindex, so there is nothing to canonicalise. */
const notFoundMeta = {
  path: '/404',
  title: 'Page not found | Open Finance ANZ',
  description: 'The page you were looking for could not be found.'
};
const notFound =
  applyHead(HEAD_LINKED, notFoundMeta)
    .replace(
      /(<meta name="robots" content=")[^"]*(">)/,
      '$1noindex, follow$2'
    )
    .replace(/\n  <link rel="canonical" href="[^"]*">/, '') +
  '\n  <main id="home" class="page active">\n' +
  '    <section class="dark">\n' +
  '      <div class="container" style="padding: 6rem 1.5rem; text-align: center;">\n' +
  '        <h1>Page not found</h1>\n' +
  '        <p style="margin: 1rem 0 2rem;">That page has moved or never existed.</p>\n' +
  '        <a class="btn" href="/">Back to the homepage</a>\n' +
  '      </div>\n' +
  '    </section>\n' +
  '  </main>\n' +
  TAIL_LINKED;
fs.writeFileSync(path.join(OUT, '404.html'), notFound, 'utf8');

assertCmsFullyApplied();

/* sitemap.xml is generated from PAGE_META rather than copied, so routes and
   sitemap cannot drift apart. Priority is retained for continuity; search
   engines largely ignore it. 404 is excluded by design. */
const SITEMAP_PRIORITY = {
  home: '1.0',
  ecosystem: '0.9',
  women: '0.8',
  events: '0.8',
  about: '0.6',
  contact: '0.5'
};

const sitemap =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  built.map(function (b) {
    const priority = SITEMAP_PRIORITY[b.page] || '0.7';
    return '  <url><loc>' + SITE_ORIGIN + b.url + '</loc>' +
           '<priority>' + priority + '</priority></url>';
  }).join('\n') +
  '\n</urlset>\n';

fs.writeFileSync(path.join(OUT, 'sitemap.xml'), sitemap, 'utf8');

/* _redirects: keep the legacy slug redirects, drop the SPA catch-all.
   Real files now exist for every route, so the catch-all would only ever
   serve the homepage with a 200 for typo URLs — a soft 404. */
const redirectsSrc = path.join(ROOT, '_redirects');
if (fs.existsSync(redirectsSrc)) {
  const cleaned = fs
    .readFileSync(redirectsSrc, 'utf8')
    .split('\n')
    .filter(function (line) { return !/^\/\*\s+\/index\.html\s+200/.test(line.trim()); })
    .join('\n');
  fs.writeFileSync(path.join(OUT, '_redirects'), cleaned, 'utf8');
}

ASSETS.forEach(function (asset) {
  copyRecursive(path.join(ROOT, asset), path.join(OUT, asset));
});

/* Extracted shared assets */
fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });
Object.keys(assets).forEach(function (name) {
  fs.writeFileSync(path.join(OUT, 'assets', name), assets[name], 'utf8');
});

/* ---------- report ---------- */

const fragCount = Object.keys(FRAGMENTS).length;
console.log('  Pre-rendered fragments: ' + fragCount +
  (fragCount ? ' (' + Object.keys(FRAGMENTS).join(', ') + ')' : ''));
console.log('  CMS copy: ' + (siteCopy ? 'baked from content/site.json' : 'HTML defaults'));
console.log('');
built.forEach(function (b) {
  console.log(
    '  ' + b.url.padEnd(28) + '-> ' + b.file.padEnd(34) +
    (b.bytes / 1024).toFixed(0) + ' KB'
  );
});
console.log('  /404' + ' '.repeat(24) + '-> 404.html');
console.log('');
Object.keys(assets).forEach(function (name) {
  console.log(
    '  shared asset'.padEnd(28) + '-> assets/' + name.padEnd(27) +
    (Buffer.byteLength(assets[name]) / 1024).toFixed(0) + ' KB'
  );
});
console.log('\n  ' + built.length + ' pages written to dist/\n');
