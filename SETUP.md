# Open Finance ANZ — deploy & CMS setup

## What's in this folder

```
index.html            The whole site (all 7 pages)
content/events.json   Event + partner content — edited by the CMS
admin/index.html      CMS entry point → yoursite.com/admin/
admin/config.yml      CMS field definitions
images/events/        Event photos land here when uploaded via the CMS
netlify.toml          Netlify config + security headers
robots.txt            Keeps /admin/ out of search results
```

Content lives in `content/events.json`. The events page fetches it at
runtime and renders from it. The CMS edits that same file and commits
to GitHub, which triggers a Netlify redeploy.

---

## An important decision I made for you

The usual Decap setup uses **Netlify Identity + Git Gateway**. I did
**not** use it, because Netlify formally deprecated both in February
2025 — no bug fixes, no support, security patches only. Netlify's own
docs now say new Git Gateway configurations are not recommended.
Building on it today means building on something already scheduled to die.

Instead this uses Decap's **`github` backend**: editors sign in with a
GitHub account. The trade-off is that anyone who edits content needs a
GitHub account with write access to the repo. For a two-founder org
that's a non-issue. If you later need to give access to someone who
shouldn't touch the repo, DecapBridge is the current drop-in answer.

---

## Setup (about 20 minutes)

### 1. Create the GitHub repo

On GitHub, create a new repository. The **owner** is your GitHub username,
or an organisation name if you create one for Open Finance ANZ. An
organisation is worth considering — it means the site isn't tied to a
personal account, and you can add Jennifer as a member.

Push the contents of this `site/` folder to the repo root, so that
`index.html` sits at the top level (not inside a `site/` subfolder).

### 2. Set the repo in config.yml

Your repo path is the two segments after `github.com/` in its URL:

    https://github.com/openfinanceanz/website
                       ^^^^^^^^^^^^^^ ^^^^^^^
                       owner          repo

Open `admin/config.yml` and edit line 17:

```yaml
backend:
  name: github
  repo: openfinanceanz/website    # <- your owner/repo
  branch: main                    # <- must match your default branch
```

Check the branch name. GitHub defaults to `main`, but if your repo uses
`master`, change it here or the CMS will fail to load content.

**The CMS will not work until this is set.**

### 3. Connect Netlify

Netlify → Add new project → Import an existing project → GitHub → pick
the repo. Publish directory `.`, no build command.

### 4. Register a GitHub OAuth app

This is the step that lets the CMS log in. You are creating your own
OAuth application — Netlify only brokers the handshake.

1. GitHub → your **Settings** (not the repo's) → **Developer settings**
   → **OAuth Apps** → **Register a new application**
2. Application name: anything, e.g. "Open Finance ANZ CMS"
3. Homepage URL: your site URL
4. **Authorization callback URL:** `https://api.netlify.com/auth/done`
   — this must be exact
5. Register, then note the **Client ID**
6. Click **Generate a new client secret** and copy it now — GitHub will
   not show it again

### 5. Add the credentials to Netlify

In your Netlify project: **Project configuration → Access & security →
OAuth** → under Authentication Providers, **Install provider** → select
**GitHub** → paste the Client ID and Client Secret → save.

### 6. Log in

Go to `yoursite.com/admin/` and sign in with GitHub. You should see two
sections: **Website Copy** and **Events & Partners**.

---

## Who can edit

Anyone signing in needs a GitHub account with **write access to the repo**.
To give Jennifer access: repo → Settings → Collaborators → add her GitHub
username. She then signs in at `/admin/` with her own GitHub account.

This is the trade-off of the `github` backend. The older Netlify Identity
approach allowed editors without GitHub accounts, but Netlify deprecated it
in February 2025. If you later need to give access to someone who shouldn't
have repo access, DecapBridge is the current answer.

---

## Using the CMS

**Add an event:** Events & Partners → Events → *Add Event*. Fill in the
fields and Publish. Netlify redeploys in ~30 seconds.

**Upcoming vs past is automatic.** Anything dated today or later shows
under Upcoming; everything else falls to Past, newest first. You never
sort anything manually.

**Photos:** each event has a Photos list. Add a photo, upload the image,
give it a caption. Files commit to `images/events/`. Landscape works
best; keep them under 3MB. No photos = no gallery, no empty space.

**Only know the year?** Fill in any date in that year and tick
*Date is approximate* — the card shows just "2025".

**Multi-day event?** Set the end date. It renders as "17–18 September 2025".

---

## Editing content without the CMS

`content/events.json` is a plain file. Editing it directly in GitHub
works fine and is sometimes quicker for a one-line fix.

---

## If you'd rather not use Decap

Decap is community-maintained now and its security response has been
slow — an XSS reported in September 2025 was still unpatched months
later. **Sveltia CMS** is the actively maintained drop-in replacement
and reads this exact `config.yml` unchanged. To switch, swap one line
in `admin/index.html`:

```html
<script src="https://unpkg.com/@sveltia/cms/dist/sveltia-cms.js" type="module"></script>
```

Nothing else changes. It's noted in a comment in that file too. Sveltia
is still in public beta, which is the reason I didn't make it the
default — but it's worth a look if the Decap editor frustrates you.

---

## Still outstanding

- **Hero image is hot-linked from Unsplash** — the only external
  dependency on the page. Self-host it.
- **Team photos and Featured In logos are placeholders** — inline SVGs,
  so they render fine, but they're not real assets.
- **Nothing under Upcoming Events.** Every event on record is past. A
  sponsor landing on an empty events calendar reads "dormant community".
- **Confirm Mastercard and Chapman Tripp** have agreed to event-partner
  billing. The other three are evidenced by our research.
