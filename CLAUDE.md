# Open Finance ANZ — website

Static site for openfinanceanz.com. Six pages, Decap CMS, deployed on Netlify.

## Why this repo is shaped the way it is

`index.html` is a single 4,300-line document containing all six pages as
`<div class="page">` blocks, switched client-side by a History API router. That
is fine for humans and broken for AI crawlers, which do not execute JavaScript.
Before `build.js` existed, every URL returned the same document with the
homepage title, description and canonical, and five content containers
(`events-upcoming`, `events-past`, `event-partners`, `report-partners`,
`women-gallery`) shipped as empty `<div></div>` and were filled by JS. The
events list and partner logos did not exist as far as GPTBot, ClaudeBot,
PerplexityBot or OAI-SearchBot were concerned.

`build.js` pre-renders that source into one real HTML file per route, with the
CMS content already baked in. **This is the invariant the whole repo exists to
protect: every route must be a distinct, fully-populated document in the raw
HTTP response, before any JavaScript runs.**

## Commands

```bash
npm run build     # index.html -> dist/
npm run verify    # assert the invariant holds; exits 1 on failure
npm run check     # both
npm run serve     # build + local server on :8080 with correct 404 handling
```

Netlify runs `node build.js && node verify.js`, so a regression fails the
deploy rather than shipping quietly.

## Architecture

```
index.html        source of ALL markup, CSS, and JS. Edit this, not dist/.
content/*.json    Decap writes here. Read at build time AND at runtime.
build.js          pre-renders index.html -> dist/
verify.js         asserts output properties; the real contract
admin/config.yml  Decap CMS config
dist/             generated. gitignored. never edit or commit.
```

`build.js` does six things: slices the six page divs out of `index.html`;
executes the site's own render functions in a `vm` to get real markup for the
five dynamic containers; substitutes `data-cms` / `data-cms-src` values from
`content/site.json`; rewrites per-page `<title>`, description and canonical from
the `PAGE_META` object inside `index.html`; neutralises the SPA click router so
links navigate natively; and extracts the shared CSS and JS into
content-hashed files under `/assets/`.

The `vm` approach is deliberate. The render functions stay the single
implementation of that markup — `build.js` runs them rather than duplicating
them, so the two cannot drift.

## The coupling contract — read before editing index.html

`build.js` pattern-matches against specific structures in `index.html`. All
mismatches now fail the build loudly rather than producing a broken site, but
you still need to know what you are touching:

| Change to `index.html` | Effect |
|---|---|
| Page div gains an extra class | Safe. Regex matches `class="page ..."` loosely. |
| Page div removed while still in `PAGE_META` | Build fails. Add or remove both together. |
| Router click handler or `useHashNavigation` reformatted | Build fails. Update the match strings in `neutraliseRouter()`. |
| Nested tag added inside a `data-cms` element | Build fails. The text substitution only handles single text nodes. |
| `PAGE_META` gains a route | Add a matching page div; sitemap updates itself. |
| New dynamic container filled by JS | Add its ID to `EXPECTED_FRAGMENTS` in `build.js` and a probe in `verify.js`. |

Each failure prints what broke and what the consequence would have been.

## Do not

- **Commit `dist/`.** Netlify regenerates it; two copies will diverge.
- **Hand-edit `sitemap.xml`.** Generated from `PAGE_META`. There is no source copy.
- **Reintroduce `/* /index.html 200` to `_redirects`.** Real files exist for every
  route now; a catch-all would serve the homepage with HTTP 200 for typo URLs,
  which is a soft 404.
- **Remove `defer` from the extracted script tag.** It preserves the execution
  order the inline block had at the end of `<body>`.
- **Add content that only appears after JS runs.** That is the original bug.

## Outstanding work

### 1. Deployment (blocking)

`verify.js` currently fails one check on purpose:

```
FAIL  admin/config.yml repo placeholder is replaced
      still set to OWNER/REPO — Decap cannot authenticate until this is a real repo
```

Steps, in order:

1. Set `repo:` in `admin/config.yml` to `owner/repository-name`. **Ask the
   repo owner for this value — do not guess it.**
2. `npm run check` — must pass clean.
3. Push to GitHub on `main`.
4. **Human step:** connect the repo in Netlify. Confirm it picked up
   `command = "node build.js && node verify.js"` and `publish = "dist"`.
5. **Human step:** Netlify → Site configuration → Access control → OAuth →
   install the GitHub provider. Decap uses the `github` backend, not the
   deprecated Git Gateway.
6. **Human step:** point the custom domain, then resubmit `sitemap.xml` in
   Search Console.

Steps 4–6 involve authentication and account settings. An agent should not
perform them; surface them to the owner instead.

Post-deploy verification against the live host:

```bash
curl -s https://SITE/events | grep -m1 "<title>"          # Events | Open Finance ANZ
curl -s https://SITE/events | grep -c "Flagship Event"     # >= 1, no JS involved
curl -s -o /dev/null -w "%{http_code}\n" https://SITE/nope # 404, not 200
curl -sI https://SITE/assets/site.*.css | grep -i cache    # immutable, max-age=31536000
```

### 2. Known issues, not blocking

- **`$`-substitution hazard in `applyHead()`.** Four `String.replace` calls use
  `'$1' + value + '$2'`. A `$&` or `` $` `` in a `PAGE_META` title or description
  would corrupt the output. No `$` present today. Fix by converting to function
  replacements if a title ever needs one.
- **`content/*.json` is fetched client-side as well as baked at build time.**
  Harmless duplicate work; it keeps CMS edits visible in the browser in the
  minute before the rebuild lands. Removing it is a defensible simplification.
- **`stubEl()` in `build.js` over-stubs.** Several DOM methods it provides are
  never called by the render path. Trimming it would make the `vm` contract
  easier to read.

### 3. Next features

- **Per-report `ScholarlyArticle` schema.** `Organization`, `WebSite` and an
  Event `ItemList` are already in `<head>`. Nine ecosystem reports are not yet
  marked up. Now genuinely possible per-page, which it was not before this build.
- **`hreflang` for AU/NZ variants** on `/ecosystem-reports`.
- **Blog page** sourced from a static `posts.json` seeded from a Medium export,
  linking out to Medium to avoid duplicate-content issues.

Do the schema work only after confirming the deploy is being crawled correctly.
If citations still do not appear once the technical fix is live, the constraint
is authority and backlinks, not markup — more schema will not help.

## Code review notes

`build.js` and `verify.js` were written by Claude and reviewed once. That review
found and fixed two critical bugs (a silently dropped page that exited 0, and a
404 page that rendered blank because the router stripped its `.active` class),
plus three quality issues. The guardrails now in place were tested against the
failure modes they catch.

A second reviewer should focus on the areas a first pass is weakest:
the `vm` sandbox in `prerenderFragments()` (what happens if `index.html`'s script
gains a dependency the stub does not provide), the regex-based HTML manipulation
in `applyCms()` and `applyHead()`, and whether `verify.js`'s assertions actually
constrain the properties that matter or merely restate what `build.js` does.
