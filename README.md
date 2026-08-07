# LinkedIn Automation Dashboard

A local, single-user web app to compose/schedule LinkedIn posts (with local desktop images), engage (like/comment) with specific posts you paste in, and generate a month of AI-drafted content with Gemini — all reviewed before anything goes live.

## What this can and can't do

LinkedIn's **Default Tier** developer access (no partner approval needed) only unlocks:
- **Sign In with LinkedIn (OpenID Connect)** — basic profile/email.
- **Share on LinkedIn** (`w_member_social`) — create posts, and like/comment on a *specific* post you already know the URL of.

There is **no** official API at this tier for browsing your feed, discovering posts, managing connections, or messaging — and building that via browser automation would violate LinkedIn's Terms of Service, so it's intentionally not part of this app. Everywhere you "engage" with a post here, you supply its URL directly.

Also: LinkedIn Default Tier access tokens **expire in 60 days with no refresh token**. The sidebar shows a connection badge (green/amber/red) so you know when to reconnect — do it from **Settings**.

## Setup

### 1. Create a LinkedIn Developer app
1. Go to https://www.linkedin.com/developers/apps and create an app.
2. Under **Products**, add **"Sign In with LinkedIn using OpenID Connect"** and **"Share on LinkedIn"** (both Default Tier, auto-approved).
3. Under **Auth**, add an **Authorized redirect URL**: `http://localhost:3000/auth/linkedin/callback` (must match `LINKEDIN_REDIRECT_URI` below exactly).
4. Copy the **Client ID** and **Client Secret**.

### 2. Configure environment
```
cp .env.example .env
```
Fill in `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET`. Everything else has a sensible default for local use.

### 3. Install and run
```
npm install
npm run initdb   # creates data/app.db with the schema (optional — happens automatically on first boot too)
npm run dev      # http://localhost:3000, auto-restarts on changes
```
(Use `npm start` instead of `npm run dev` for a plain, non-restarting run.)

### 4. Connect your account
Open http://localhost:3000/settings and click **Connect LinkedIn account**.

### 5. (Optional) AI content planning
Get a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey), paste it into Settings along with your content preferences (topics, tone, audience, cadence), then go to **AI Calendar** and click **Generate month plan**. Nothing publishes automatically — review, edit, and **Approve** each draft individually to send it into the normal scheduling queue.

## How scheduling works

An in-process `node-cron` job checks every minute for posts whose `scheduledFor` time has passed, claims them (so a manual "Post Now" click and the cron tick can never double-post the same row), and publishes them. This only runs **while the app process is running** — if you close the terminal, scheduled posts pause until you restart it. For unattended operation across reboots, consider running it with [PM2](https://pm2.keymetrics.io/) or as a Windows service.

## Auto-update (for a machine you leave running as a server)

If you're running this on a second PC that stays on and just runs the app continuously, you can have it pull and apply your GitHub pushes automatically instead of manually updating that machine. It's **off by default** — turn it on only on that machine, not your normal dev machine, so it doesn't restart itself out from under you mid-session.

In `.env` on that machine:
```
AUTO_UPDATE_ENABLED=true
AUTO_UPDATE_INTERVAL_MINUTES=30
```

Every interval, it:
1. `git fetch`es `origin/main` and compares against local `HEAD`.
2. Skips the cycle if there are uncommitted local changes to tracked files (won't overwrite them), or if a post is currently mid-publish (won't restart while that's in flight — safe by design, not just by luck: see the stale-lock handling in `storage.service.js`).
3. Otherwise `git pull --ff-only`s, runs `npm install` if `package.json`/`package-lock.json` changed, and restarts itself via the batch launcher.

Requirements: that machine's copy of this folder needs to be an actual git clone of your GitHub repo (not just a copied folder) with `git`/`npm` on PATH, and read access to the repo (a public repo needs nothing extra; a private one needs `git` configured with a credential that can pull it, e.g. a PAT or an authenticated `gh`/Git Credential Manager).

This checks on a timer rather than reacting to the push instantly — good enough for a personal tool, at the cost of up to `AUTO_UPDATE_INTERVAL_MINUTES` of lag after a push. If that lag ever bothers you, the proper fix is a self-hosted GitHub Actions runner on that machine (reacts to pushes immediately, no port-forwarding needed since it polls GitHub outbound) — ask if you want that built instead.

## Project layout

```
src/
  config/      env, SQLite connection + schema, LinkedIn API constants
  routes/      dashboard, auth (OAuth), posts, engagement, ai
  services/    LinkedIn API calls, Gemini calls, media validation, storage (DB) layer
  scheduler/   node-cron entrypoint + the actual claim/publish/retry logic
  views/       EJS templates
  public/      CSS + client-side JS (incl. the LinkedIn post preview renderer)
data/app.db    local SQLite database (gitignored)
```

`services/storage.service.js` is the only file that talks to SQLite directly, and every function is `async` even though the underlying calls are synchronous — that's deliberate, so a future move to a cloud store (e.g. Firestore) only means rewriting this one file's internals, not any of the routes/scheduler code that calls it.

## Notes / known limits

- **Images only** for now (jpg/png/gif, ≤20MB); video posting isn't implemented (LinkedIn's video upload is a more involved chunked-upload API).
- A local file path you reference is read **at post time**, not when you schedule it — if it's on a OneDrive-synced Desktop, make sure it's fully downloaded (not a cloud-only placeholder) by the scheduled time.
- Failed posts retry up to 3 times with a 5-minute backoff, then land in **Queue** as `failed` for a manual retry.
