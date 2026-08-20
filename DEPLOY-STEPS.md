# Deploy steps — openfinanceanz.com

The build is written and tested. Six numbered steps, ~30 minutes.

---

## What changed

**One new file: `build.js`.** Nothing else about how you author the site changed.
`index.html` is still the single source of markup. Decap still writes to
`content/site.json` and `content/events.json`. The render functions inside
`index.html` are still the only copy of the events/partners markup — the build
executes them rather than reimplementing them, so the two can't drift apart.

`netlify.toml` gained a build command and a cache rule. `dist/` is what ships.

**Before** — every URL returned the same document:

| | Before | After |
|---|---|---|
| Unique titles across 6 URLs | 1 | 6 |
| Unique canonicals | 1 (all → `/`) | 6 |
| `<h1>` per document | 6 | 1 |
| Events / partners / gallery in raw HTML | empty containers | fully rendered |
| Words in raw HTML | 2,014 in one blob | 249–580 per topic page |
| HTML per page | ~147 KB | 17–25 KB |
| Unknown URLs | homepage, HTTP 200 | real 404 |

The five empty containers were the real content hole: `events-upcoming`,
`events-past`, `event-partners`, `report-partners`, `women-gallery` shipped as
`<div></div>` and were filled by JS. AI crawlers never ran that JS, so your
event history and partner list did not exist as far as they were concerned.

**Shared assets are extracted.** The 2,400-line stylesheet and 740-line script
now live at `/assets/site.<hash>.css` (54 KB) and `/assets/site.<hash>.js`
(30 KB), fetched once and cached immutably. Without this, six documents would
each carry ~85 KB of identical bytes and every navigation would re-parse them —
a real regression against the in-page routing you had. Filenames carry a content
hash, so a change to either file produces a new URL and busts the cache on its
own. JSON-LD stays inline, since it's per-page metadata rather than a shared
asset.

Verified end to end over HTTP: all six routes return 200 as independent
documents, both assets resolve, unknown paths 404.

---

## Step 1 — Set the CMS repo

`admin/config.yml` line 18 still says:

```yaml
  repo: OWNER/REPO # <-- CHANGE THIS
```

Change to your actual repo, e.g. `repo: openfinanceanz/website`.
**The CMS cannot authenticate until this is set.**

## Step 2 — Push to GitHub

```bash
git init
git add .
git commit -m "Static multi-page build"
git branch -M main
git remote add origin git@github.com:OWNER/REPO.git
git push -u origin main
```

Add `dist/` to `.gitignore` — Netlify regenerates it on every deploy. (I've
included a built `dist/` in the package so you can inspect the output; it
doesn't need to be committed.)

## Step 3 — Connect Netlify

New site → import from GitHub → select the repo. Netlify reads `netlify.toml`
and will use `node build.js` / publish `dist`. Confirm both fields before the
first deploy.

## Step 4 — Enable CMS auth

Decap's `github` backend needs an OAuth handshake to let editors sign in —
there's no Git Gateway (deprecated Feb 2025, correctly avoided in your
config). Netlify brokers that handshake, but it doesn't supply the OAuth
app itself — you register your own, in two parts.

**4a. Register a GitHub OAuth app** (this creates the Client ID and Secret —
they don't exist until you do this):

1. GitHub → your **Settings** (not the repo's) → **Developer settings** →
   **OAuth Apps** → **New OAuth App** — direct link:
   [github.com/settings/developers](https://github.com/settings/developers)
2. Application name: anything, e.g. "Open Finance ANZ CMS"
3. Homepage URL: your site URL
4. **Authorization callback URL:** `https://api.netlify.com/auth/done` —
   must be exact, this is Netlify's fixed endpoint, not yours
5. Register, then note the **Client ID** shown on the app's page
6. Click **Generate a new client secret** and copy it immediately — GitHub
   only shows it once

**4b. Give the credentials to Netlify:** Site configuration → Access control
→ OAuth → Install provider → GitHub → paste the Client ID and Client
Secret → save.

Then visit `/admin/` and sign in with a GitHub account that has write
access to the repo.

## Step 5 — Verify the fix landed

This is the step that matters. **View source, not DevTools** — DevTools shows
the post-JavaScript DOM, which is exactly what crawlers don't see.

```bash
curl -s https://YOURSITE.netlify.app/events | grep -m1 "<title>"
# expect: <title>Events | Open Finance ANZ</title>

curl -s https://YOURSITE.netlify.app/events | grep -c "Intersekt 2025 Roundtable"
# expect: 1 or more — event content present without JS

curl -s https://YOURSITE.netlify.app/about | grep "rel=\"canonical\""
# expect: href="https://www.openfinanceanz.com/about"

curl -s -o /dev/null -w "%{http_code}\n" https://YOURSITE.netlify.app/no-such-page
# expect: 404, not 200
```

Then check the shared assets resolve and are cached:

```bash
curl -sI https://YOURSITE.netlify.app/assets/site.7f0c297676.css | grep -i "cache-control\|HTTP"
# expect: 200 and max-age=31536000, immutable
```

If all pass, the AI-crawlability problem is closed and page weight is down
roughly 85%.

## Step 6 — Point the domain, then resubmit

Add the custom domain, then in Search Console resubmit `sitemap.xml`. The three
URLs already indexed (`/`, `/about`, `/women-in-open-banking-anz`) keep working;
the other three become independently indexable for the first time.

---

## Two things to know about maintenance

**Every CMS edit needs a deploy to reach AI crawlers.** Decap commits to `main`
→ Netlify rebuilds → the new copy is baked into the HTML. Visitors with a
browser see changes as soon as the commit lands (the client-side fetch is still
there); AI crawlers see them once the build finishes, usually under a minute.
This is now automatic — but it's why the build step was necessary rather than
optional.

**If you edit the router or render functions in `index.html`**, the build prints
a warning: `Router neutralisation patched N/2 blocks`. That means it no longer
recognises the code it needs to patch. Don't deploy past that warning without
checking `build.js` — it's the one place the two files are coupled.

---

## Code changes now go through pull requests

`main` is protected: non-admin collaborators can't push straight to it, and
every code change should go through a branch and a pull request, which gets
a **Netlify Deploy Preview** — a real, working URL for that exact change —
before it ever reaches the live site.

This exists because of a real incident: a change shipped straight to `main`
that looked fine locally but broke every image on every page except the
homepage, live, with no warning. A PR preview would have caught it before
anyone but the editor saw it.

**The workflow:**
```bash
git checkout -b short-description-of-change
# make the change
git add .
git commit -m "Describe what changed"
git push -u origin short-description-of-change
gh pr create   # or open the PR on github.com — GitHub prompts for this after a branch push
```
Netlify comments on the PR with a preview link once it builds (usually under
a minute). Check the actual pages that changed on that link, not just that
the build succeeded — the images bug above passed a clean build. Once it
looks right, merge the PR; Netlify then rebuilds and deploys `main` as usual.

**One deliberate exception: repo admins can still push directly.**
Branch protection has `enforce_admins` turned *off*, not on. This is not an
oversight — Decap CMS's `github` backend (`publish_mode: simple`) commits
straight to `main` when someone publishes at `/admin/`, authenticated as
whichever GitHub account is logged in. If that account is a repo admin (as
Brenton's and Jennifer's are), a hard block on admin pushes would break
publishing from the CMS entirely. So the PR requirement is a hard wall for
outside collaborators, and a **discipline** for admins and for Claude:
code changes go through the branch → PR → preview → merge flow every time,
even though the door is technically still open to skip it. CMS content
edits are unaffected either way — they were never the source of the bug
this workflow exists to catch.

---

## Corrections to my earlier audit

Worth stating plainly, since I sent you a scored audit built on wrong readings:

- I said hash routing. It's History API path routing with a hash fallback only
  for opaque origins.
- I said reports/events/WebSite schema were missing. Organization, WebSite, and
  an Event `ItemList` were already in the head.
- I ranked schema markup as priority #1. It couldn't have worked — schema on a
  single shared document can't differentiate six pages. The routing fix had to
  come first, which was your call, not mine.

Schema refinements (`ScholarlyArticle` per report edition, `hreflang` for AU/NZ)
are still worth doing and now actually can be per-page. But they're a week-two
task. Ship this first, then measure whether you're being cited before spending
more on markup — if you're not, the gap will be authority and backlinks, not
technical.
