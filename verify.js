#!/usr/bin/env node
/* ============================================================
   Open Finance ANZ — post-build verification
   ------------------------------------------------------------
   Asserts the properties the build exists to guarantee. Run after
   `node build.js`. Exits non-zero on any failure.

     node build.js && node verify.js

   These checks are deliberately about *output*, not implementation:
   they would still be correct if build.js were rewritten from
   scratch. If you change how the site is built, this file is the
   contract that says whether it still works.

   Deps: none (Node 18+)
   ============================================================ */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'dist');
const ORIGIN = 'https://www.openfinanceanz.com';

const ROUTES = [
  { url: '/', file: 'index.html' },
  { url: '/ecosystem-reports', file: 'ecosystem-reports/index.html' },
  { url: '/women-in-open-banking-anz', file: 'women-in-open-banking-anz/index.html' },
  { url: '/events', file: 'events/index.html' },
  { url: '/about', file: 'about/index.html' },
  { url: '/contact', file: 'contact/index.html' }
];

/* Text that must appear in the raw HTML of a given route. This is the
   check that actually matters: it is the content AI crawlers could not
   see before the build existed. Update if the CMS content changes. */
const CONTENT_PROBES = [
  { file: 'events/index.html', needle: 'Flagship Event', label: 'event listing' },
  { file: 'ecosystem-reports/index.html', needle: 'Consumer Data Right', label: 'report copy' },
  { file: 'women-in-open-banking-anz/index.html', needle: 'women-gallery', label: 'gallery container' }
];

let failures = 0;

function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (ok || !detail ? '' : '\n          ' + detail));
  return ok;
}

function read(rel) {
  const file = path.join(OUT, rel);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

function firstMatch(html, re) {
  const m = html.match(re);
  return m ? m[1] : null;
}

/* Strip script and style so text assertions reflect what a crawler reads. */
function textOf(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

console.log('\nOpen Finance ANZ — verifying dist/\n');

if (!fs.existsSync(OUT)) {
  console.error('  dist/ does not exist. Run `node build.js` first.\n');
  process.exit(1);
}

/* ---------- 1. every route is its own document ---------- */

console.log('Routes');
const titles = new Set();
const canonicals = new Set();

ROUTES.forEach(function (route) {
  const html = read(route.file);
  if (!check(route.url + ' exists', html !== null, 'expected dist/' + route.file)) return;

  const title = firstMatch(html, /<title>([\s\S]*?)<\/title>/);
  const canonical = firstMatch(html, /<link rel="canonical" href="([^"]*)">/);
  const h1Count = (html.match(/<h1[\s>]/g) || []).length;
  const words = textOf(html).split(' ').length;

  if (title) titles.add(title);
  if (canonical) canonicals.add(canonical);

  check(
    route.url + ' canonical is self-referencing',
    canonical === ORIGIN + route.url,
    'got ' + canonical
  );
  check(route.url + ' has exactly one <h1>', h1Count === 1, 'found ' + h1Count);
  check(route.url + ' has substantive text', words > 150, 'only ' + words + ' words');
  check(
    route.url + ' links shared CSS and JS',
    /<link rel="stylesheet" href="\/assets\/site\.[a-f0-9]+\.css">/.test(html) &&
      /<script src="\/assets\/site\.[a-f0-9]+\.js" defer><\/script>/.test(html)
  );
  check(
    route.url + ' has no inline <style> or bare <script>',
    !/<style>/.test(html) && !/\n  <script>\n/.test(html)
  );
});

console.log('\nUniqueness');
check('all ' + ROUTES.length + ' titles are distinct', titles.size === ROUTES.length,
  'got ' + titles.size + ' unique of ' + ROUTES.length);
check('all ' + ROUTES.length + ' canonicals are distinct', canonicals.size === ROUTES.length,
  'got ' + canonicals.size + ' unique of ' + ROUTES.length);

/* ---------- 2. dynamic content is in the raw HTML ---------- */

console.log('\nPre-rendered content (the reason this build exists)');
CONTENT_PROBES.forEach(function (probe) {
  const html = read(probe.file);
  check(
    probe.label + ' present in ' + probe.file,
    html !== null && html.indexOf(probe.needle) !== -1,
    'expected to find "' + probe.needle + '" in the raw HTML'
  );
});

const eventsHtml = read('events/index.html') || '';
check(
  'events containers are not empty',
  !/<div id="events-upcoming"[^>]*><\/div>/.test(eventsHtml) &&
    !/<div id="events-past"[^>]*><\/div>/.test(eventsHtml),
  'a container shipped empty — content would be invisible to crawlers'
);

/* ---------- 3. 404 ---------- */

console.log('\n404');
const notFound = read('404.html');
if (check('404.html exists', notFound !== null)) {
  const divId = firstMatch(notFound, /<main id="([a-z0-9_-]+)" class="page active">/);
  check(
    '404 page id is "home" so the router fallback keeps it visible',
    divId === 'home',
    'id is "' + divId + '" — pageFromLocation() falls back to "home" on unknown ' +
      'paths, so any other id gets .active stripped and renders blank'
  );
  check('404 is noindex', /content="noindex/.test(notFound));
  check('404 has no canonical', !/rel="canonical"/.test(notFound));
}

/* ---------- 4. sitemap matches the built routes ---------- */

console.log('\nSitemap');
const sitemap = read('sitemap.xml');
if (check('sitemap.xml exists', sitemap !== null)) {
  const locs = (sitemap.match(/<loc>([^<]*)<\/loc>/g) || []).map(function (l) {
    return l.replace(/<\/?loc>/g, '');
  });
  const expected = ROUTES.map(function (r) { return ORIGIN + r.url; });
  check(
    'sitemap lists exactly the built routes',
    locs.length === expected.length && expected.every(function (e) { return locs.indexOf(e) !== -1; }),
    'sitemap: ' + locs.length + ' entries, built: ' + expected.length
  );
  check('sitemap excludes 404', locs.indexOf(ORIGIN + '/404') === -1);
}

/* ---------- 5. redirects and assets ---------- */

console.log('\nDeploy config');
const redirects = read('_redirects');
if (check('_redirects exists', redirects !== null)) {
  check(
    'SPA catch-all is removed',
    !/^\/\*\s+\/index\.html\s+200/m.test(redirects),
    'a catch-all would serve the homepage with HTTP 200 for unknown URLs (soft 404)'
  );
  check('legacy slug redirects retained', /\/about-us\s+\/about\s+301/.test(redirects));
}

const assetDir = path.join(OUT, 'assets');
const assetFiles = fs.existsSync(assetDir) ? fs.readdirSync(assetDir) : [];
check('one hashed CSS file emitted',
  assetFiles.filter(function (f) { return /^site\.[a-f0-9]+\.css$/.test(f); }).length === 1);
check('one hashed JS file emitted',
  assetFiles.filter(function (f) { return /^site\.[a-f0-9]+\.js$/.test(f); }).length === 1);
check('admin/ is present for the CMS', fs.existsSync(path.join(OUT, 'admin', 'index.html')));
check('content/ is present for runtime CMS refresh', fs.existsSync(path.join(OUT, 'content', 'site.json')));

/* ---------- 6. CMS placeholder ---------- */

console.log('\nCMS');
const cfg = fs.existsSync(path.join(__dirname, 'admin', 'config.yml'))
  ? fs.readFileSync(path.join(__dirname, 'admin', 'config.yml'), 'utf8')
  : '';
check(
  'admin/config.yml repo placeholder is replaced',
  cfg && !/repo:\s*OWNER\/REPO/.test(cfg),
  'still set to OWNER/REPO — Decap cannot authenticate until this is a real repo'
);

/* ---------- result ---------- */

console.log('');
if (failures) {
  console.error('  ' + failures + ' check(s) failed.\n');
  process.exit(1);
}
console.log('  All checks passed.\n');
