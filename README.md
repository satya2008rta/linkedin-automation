# LinkedIn Automation Dashboard

A self-hosted, single-user web app for planning, drafting, scheduling, and publishing LinkedIn content — for your personal profile or a Company Page you administer — with AI assistance (Google Gemini) for writing and rewriting posts. Runs entirely on your own machine; nothing is hosted for you.

This document is written for **anyone picking up this codebase for the first time** — a new machine, a new team member, or a second PC you want running as an unattended server. Follow it top to bottom on a fresh checkout and you should end up with a fully working instance.

---

## 1. What this app actually does

- **Compose** — write a post (text + optional local image), schedule it or publish immediately, as yourself or as a Company Page you administer.
- **Queue** — see everything pending/failed, edit it, retry it, or publish it right now.
- **AI Calendar** — generate a batch of draft posts for a date range using Gemini, reviewed in an Outlook-style monthly calendar (drag-and-drop to reschedule), nothing goes live until you explicitly **Approve** each draft.
- **✨ AI Write/Rewrite** — a free-text prompt box (available in Compose, Queue, and AI Calendar) that either writes a post from scratch or rewrites existing text per your instruction.
- **Engage** — paste a specific LinkedIn post URL to like/comment on it.
- **Posted** — history of everything actually published, with links back to LinkedIn.
- **Settings** — connect/reconnect your LinkedIn account, manage AI preferences and your Gemini key, see which Company Pages you can post as.

## 2. What LinkedIn's API will and won't let this do

This matters before you set anything up, because it shapes what's actually possible:

- **No native scheduling exists in LinkedIn's API.** Every post submitted through the API publishes immediately. This app's own scheduler (an in-process timer) is what makes "schedule for later" work — it isn't a workaround for a missing feature, it's the *only* way to do it.
- **No feed/discovery access.** There's no API for browsing your feed, finding posts, or seeing what your network is posting. The Engage page requires you to paste a URL you found yourself by browsing LinkedIn normally.
- **No connections/messaging API** at this access tier, and building that via browser automation would violate LinkedIn's Terms of Service — intentionally out of scope, full stop.
- **Company Page posting is optional and gated separately** — it requires an extra LinkedIn product (Community Management API) and LinkedIn's approval, on top of the basic posting permission. See §5.
- **Access tokens expire in 60 days with no refresh token.** You will need to reconnect periodically from Settings — the sidebar shows a color-coded countdown (green/amber/red) so this doesn't sneak up on you.

## 3. Requirements

| Requirement | Notes |
|---|---|
| **Windows** | The launcher script, the native browse dialog fallback, and the setup instructions below are Windows-specific. The core Node/Express app itself is cross-platform, but you'd need to adapt the `.bat` launcher and a couple of PowerShell-shelled routes to run this on Mac/Linux. |
| **Node.js ≥ 22.5** | Required specifically for the built-in `node:sqlite` module this app uses as its database (see §11) — no separate database server to install, and deliberately no native npm module requiring a C++ build toolchain. |
| **Git** | To clone the repo and (optionally) push/pull updates. |
| **A LinkedIn account** | With a Developer account at https://www.linkedin.com/developers — free, no approval needed to get started. |
| **(Optional) A Google account** | For a free Gemini API key, only needed if you want the AI content features. |

## 4. Getting the code

### 4a. Install the prerequisites (Windows, one time)

Run these in PowerShell or Command Prompt. Skip any tool you already have (check with `git --version` and `node --version`).

```
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS -e
```

Close and reopen your terminal afterwards so `git`, `node` and `npm` are picked up on `PATH`, then confirm:

```
git --version
node --version     # must be v22.5.0 or newer
npm --version
```

If `winget` installs a Node version older than 22.5, install the current release instead: `winget install --id OpenJS.NodeJS --version 22` or download it from https://nodejs.org.

### 4b. Clone the repo and install the app's dependencies

```
git clone https://github.com/satya2008rta/linkedin-automation.git
cd linkedin-automation
npm install
```

`npm install` reads `package.json` / `package-lock.json` and installs everything into `node_modules/`:

| Package | Purpose |
|---|---|
| `express`, `express-session`, `express-ejs-layouts`, `ejs`, `connect-flash` | Web server, sessions, page templates, flash messages |
| `axios` | LinkedIn API calls |
| `@google/generative-ai` | Gemini AI features |
| `node-cron` | Post scheduler |
| `date-fns` | Date handling |
| `dotenv` | Loads `.env` |
| `mime-types` | Image type validation |
| `nodemon` (dev) | Auto-restart for `npm run dev` |

These are plain-JS dependencies only — no native compilation step, so this should complete cleanly even on a machine with no build tools installed. There is no database server to install either; the app uses Node's built-in `node:sqlite`.

For a clean, reproducible install that exactly matches the lockfile (e.g. on a server), use `npm ci` instead of `npm install`. To skip dev tools, add `--omit=dev`.

### 4c. Quick start (everything in one go)

```
copy .env.example .env
npm install
npm start
```

Then edit `.env` with your LinkedIn credentials (§5–§6) and open http://localhost:3000.

## 5. Set up your LinkedIn Developer app

1. Go to https://www.linkedin.com/developers/apps and click **Create app**. Fill in the required fields (name, LinkedIn Page association, logo, etc.) — you'll need to associate it with *some* LinkedIn Page even if you only intend to post to your personal profile; LinkedIn requires this for every app.
2. Open your new app → **Products** tab → add:
   - **"Sign In with LinkedIn using OpenID Connect"** — auto-approved, no waiting.
   - **"Share on LinkedIn"** — auto-approved, no waiting. Together these two are all you need for personal posting/scheduling/engaging.
3. **(Optional, for posting as a Company Page)** Also add **"Community Management API"**. This one is *not* always instantly approved — LinkedIn may review it. It requires the app to already be associated with a Page you administer (step 1). Until it's approved, the app's Company Page features simply show "no pages found" and personal posting is unaffected — nothing breaks while you wait.
4. Open the **Auth** tab:
   - Copy the **Client ID** and **Client Secret** — you'll need both shortly.
   - Under **Authorized redirect URLs**, add exactly: `http://localhost:3000/auth/linkedin/callback` (must match `LINKEDIN_REDIRECT_URI` in your `.env`, below, character-for-character — including the port).

## 6. Configure `.env`

```
cp .env.example .env
```

Then fill in:

| Variable | Required? | What it's for |
|---|---|---|
| `PORT` | No (defaults 3000) | Local port the app listens on. |
| `SESSION_SECRET` | Recommended | Random string for signing session cookies — the launcher batch file doesn't set this for you; pick anything long and random. |
| `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` | **Yes** | From §5 step 4. Without these, the "Connect LinkedIn account" button fails immediately with a clear error telling you to fill these in. |
| `LINKEDIN_REDIRECT_URI` | Yes (has a default) | Must exactly match what you registered in §5 step 4. |
| `LINKEDIN_API_VERSION` | Yes (has a default, **will go stale**) | Format `YYYYMM`. LinkedIn retires each monthly API version ~12 months after release — if posts start failing with `"Requested version ... is not active"`, this is why. Fix: check the "Latest Version" table at https://learn.microsoft.com/linkedin/marketing/versioning and bump this value. This *will* happen eventually; it's not a bug when it does. |
| `GEMINI_API_KEY` | No | Only needed for AI features. Can also be pasted directly into the Settings page instead (the in-app copy takes precedence, and it's never re-displayed once saved). See §8 for the exact Google Cloud setup gotchas we've personally hit. |
| `AUTO_UPDATE_ENABLED` / `AUTO_UPDATE_INTERVAL_MINUTES` | No (default off) | Only relevant for a second machine you're running as an unattended server — see §10. Leave this off on your normal working machine. |

## 7. First run

**Windows, easiest path:** double-click **`Start LinkedIn Automation.bat`** in the project root. It:
1. Creates `.env` from `.env.example` automatically if missing (you'll still need to edit in your real LinkedIn credentials before connecting).
2. Detects the configured port and **kills any previous instance of the app still holding it** — so re-launching after a code change always runs the current code, not a stale process. It tries a graceful kill first, force-kills only if needed.
3. Runs `npm install` automatically the first time (skipped on subsequent launches once `node_modules` exists).
4. Starts the server and opens your browser to it automatically after a few seconds.
5. Leave the console window open while you use the app — closing it (or Ctrl+C) stops the server, including the scheduler.

**Manual alternative** (any OS, once you've adapted the Windows-specific bits):
```
npm start          # plain run
npm run dev         # auto-restarts on file changes (nodemon)
npm run initdb      # optional — creates data/app.db up front; happens automatically on first boot anyway
```

Either way, confirm it's actually up: `http://localhost:3000/health` should return `{"ok":true}`.

## 8. Connect your LinkedIn account

1. Open **Settings** in the app.
2. Click **Connect LinkedIn account** — this redirects you to LinkedIn's real login/consent screen.
3. Approve it. You're redirected back and Settings should now show "Connected as `<your name>`" with a token expiry date roughly 60 days out.
4. If you added Community Management API in §5 step 3, the same reconnect also attempts to fetch the list of Company Pages you administer — if approval hasn't landed yet, this silently comes back empty (not an error) and you can click **Refresh company pages** later once it has.

## 9. (Optional) Set up Gemini for AI features

1. Get a free key from https://aistudio.google.com/apikey. **Use "Create API key in new project"** rather than an existing project — a fresh project defaults to an unrestricted key and avoids two specific problems we ran into building this app:
   - An existing/shared GCP project can have **API restrictions** on the key that silently block the Generative Language API even though the key looks valid — if you ever see `API_KEY_SERVICE_BLOCKED`, this is why; fix it under Google Cloud Console → Credentials → your key → API restrictions.
   - A project can have the Generative Language API **not enabled** at all — if you see `Gemini API has not been used in project ... or it is disabled`, enable it at the URL the error message gives you and wait a minute or two.
2. Paste the key into **Settings** (Gemini API key field) — or set `GEMINI_API_KEY` in `.env` as a fallback (the Settings value wins if both are set).
3. Fill in your content preferences on the same page: topics, tone, target audience, posting cadence, preferred times.
4. Go to **AI Calendar**, pick a date range, click **Generate plan for date range**. Drafts appear in the calendar and a review list below it — nothing publishes until you **Approve** each one individually.

**Billing note:** Gemini's free tier is not available in every country/region — if your account isn't eligible, generation will fail with a billing-related error even with a valid, correctly-scoped key, and you'll need to enable billing on that Google Cloud project (a card on file; Gemini's Flash-tier pricing is inexpensive for this app's usage pattern of maybe a few dozen short generations a month).

**Model staleness:** the app uses Google's `gemini-flash-latest` rolling alias rather than a dated model name specifically so it doesn't break the way a pinned model eventually would — but if Google ever restructures their model lineup, check `src/services/gemini.service.js`'s `MODEL_NAME` constant (overridable via a `GEMINI_MODEL` env var if you want to pin a specific model instead).

## 10. (Optional) Running a second machine as an always-on server, kept in sync

If you want this running continuously on a machine you don't actively develop on, two independent things need to be true — don't conflate them:

**a) Code stays up to date.** Set on that machine's `.env`:
```
AUTO_UPDATE_ENABLED=true
AUTO_UPDATE_INTERVAL_MINUTES=30
```
Every interval, the running app itself does `git fetch origin main`, and if there's something new: skips the cycle if there are uncommitted local changes (won't clobber them) or a post is currently mid-publish (won't restart mid-request — this is the same protection described in §12's duplicate-post note), otherwise `git pull --ff-only`s, runs `npm install` only if `package.json`/`package-lock.json` changed, and restarts itself via the same launcher logic described in §7. That machine's copy of this folder needs to actually be a `git clone` (not a manually copied folder) with `git`/`npm` on `PATH`, and read access to the repo.

**b) Data does *not* sync automatically.** Each machine has its own independent local database (`data/app.db` — see §11) — its own posts, queue, settings, and LinkedIn token. Pushing code to GitHub does not move any content between machines, and there is currently no shared/cloud data layer. If you need the *same* queue/drafts visible and editable from two machines, that requires migrating the storage layer to a shared backend (the codebase is deliberately structured — see §11 — to make that swap possible later without touching route code, but it hasn't been built).

## 11. Project structure, for anyone modifying this

```
Start LinkedIn Automation.bat   Windows launcher (kills stale instance, npm install if needed, opens browser)
.env.example                    Template — copy to .env, see §6 for what every value does
scripts/
  initDb.js                     One-off DB smoke test/creation
  openBrowser.bat               Small helper the launcher spawns to open your browser after a delay
src/
  server.js                     Express app bootstrap — session/flash middleware, route mounting, starts the scheduler
  config/
    env.js                      Loads/validates .env, exposes typed config
    db.js                       node:sqlite connection + full schema + lightweight column migrations
    linkedin.js                 LinkedIn API base URLs, OAuth scopes, shared request headers
  routes/
    auth.routes.js               OAuth connect/callback/logout, company-page refresh
    posts.routes.js              Compose/Queue CRUD, media upload/browse, post-now/retry/cancel, calendar drag-reschedule
    ai.routes.js                 AI settings, plan generation, draft update/approve/discard, the ✨ write/rewrite endpoint
    engagement.routes.js         Paste-a-URL like/comment
    dashboard.routes.js          Page renders (dashboard/compose/queue/posted/calendar/engage/settings)
  services/
    linkedinAuth.service.js      OAuth token exchange + userinfo
    linkedinPost.service.js      Image upload + post creation (personal or Company Page author)
    linkedinEngagement.service.js Like/comment API calls
    linkedinOrg.service.js       Discovers which Company Pages you administer
    gemini.service.js            All Gemini calls: monthly plan generation, ✨ write/rewrite
    media.service.js             Local image file validation (type/size/existence)
    storage.service.js           The ONLY file that talks to the database directly (see below)
  scheduler/
    cron.js                      Ticks every minute, hands due posts to postRunner
    postRunner.js                Claim → publish → retry/backoff logic, shared by cron and manual "Post Now"
    autoUpdate.js                Opt-in git-pull-and-restart checker, see §10
  middleware/                    Error handling, token-validity gate
  utils/                         Logging, date formatting, URN parsing (for Engage URLs)
  views/                         EJS templates, one per page
  public/                        CSS + client-side JS (LinkedIn post preview renderer, shared modal/button behaviors)
data/
  app.db                         Local SQLite database (gitignored — never committed)
  uploads/                       Locally-saved images from the browser-based file picker (gitignored)
```

**`storage.service.js` is deliberately the only file that touches the database.** Every function in it is `async` even though `node:sqlite` is synchronous under the hood — that's on purpose, so a future move to a shared/cloud database only means rewriting this one file's internals, not any route or scheduler code that calls it.

## 12. How scheduling and publishing actually work

- An in-process timer checks every minute for posts whose scheduled time has passed, atomically claims them (so a manual "Post Now" click and the timer can never double-publish the same post), and publishes them.
- **This only runs while the app process is alive.** Close the window, scheduled posts pause until you restart — there's no OS-level service wrapping this by default. For true unattended operation across reboots, consider running it under something like PM2 or as a registered Windows service (not currently built into this app).
- Every LinkedIn API call has a 30-second timeout, specifically so a stalled network request can't leave a post hanging indefinitely.
- If the app process is killed mid-publish (e.g. an ungraceful restart), the post is **not** silently retried — it's marked `failed` with an explicit "status on LinkedIn is unknown, check manually before retrying" warning. This is deliberate: auto-retrying an interrupted request risks creating a duplicate post if the original actually went through before the process died.
- Failed posts retry automatically up to 3 times with a 5-minute backoff, then sit in **Queue** as `failed` for you to review/edit/retry manually.

## 13. Troubleshooting quick-reference

| Symptom | Likely cause / fix |
|---|---|
| `Requested version ... is not active` | `LINKEDIN_API_VERSION` has aged out — bump it, see §6. |
| Posting fails right after a fresh reconnect | Confirm the redirect URL registered on LinkedIn's Auth tab matches `LINKEDIN_REDIRECT_URI` exactly. |
| `API_KEY_SERVICE_BLOCKED` from Gemini | Your API key has restrictions blocking the Generative Language API — see §9. |
| `Gemini API has not been used in project ...` | The API isn't enabled on that Google Cloud project — see §9. |
| Gemini calls fail with a billing/quota error despite a valid key | Free tier may not be available in your region — enable billing on that Google Cloud project. |
| "No company pages found" after adding Community Management API | You need to **reconnect** (not just refresh) so your token actually carries the new scopes — a product being added in the portal doesn't retroactively upgrade a token you already have. If reconnecting still shows nothing, LinkedIn likely hasn't approved the product for your app yet. |
| App won't start: address already in use | Something's still holding the port — use the `.bat` launcher, which finds and kills a stale instance automatically; running `node src/server.js` directly bypasses that safety net. |
| A queued post is stuck on `posting` for a long time | Almost certainly an interrupted process (see §12) — it'll self-resolve to `failed` after 5 minutes, at which point check LinkedIn manually before retrying. |

## 14. Known limitations (by design, not oversights)

- Images only (jpg/png/gif, ≤20MB) — no video posting yet; LinkedIn's video upload API is a more involved chunked-upload flow.
- A referenced local image path is read **at post time**, not when scheduled — if it lives on a OneDrive-synced Desktop, make sure it's actually downloaded (not a cloud-only placeholder) by the scheduled time.
- Single local user, single local database per machine — see §10 for what that means for a multi-machine setup.
- No feed reading, no connection/message automation — see §2.
