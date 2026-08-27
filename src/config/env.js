const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  return value;
}

const env = {
  port: Number(required('PORT', 3000)),
  sessionSecret: required('SESSION_SECRET', 'dev-secret-change-me'),
  adminEmail: required('ADMIN_EMAIL', 'satyasundar2008@gmail.com').toLowerCase(),
  appBaseUrl: required('APP_BASE_URL', 'http://localhost:3000').replace(/\/+$/, ''),
  // Off by default so local http://localhost keeps working (browsers silently drop
  // "Secure" cookies over plain HTTP — flipping this on prematurely would break sign-in
  // for anyone not behind HTTPS). Set COOKIE_SECURE=true once this runs behind real HTTPS
  // (e.g. hosted online later) — this one flag is the only session-cookie change needed
  // for that move, no code changes required.
  cookieSecure: required('COOKIE_SECURE', 'false') === 'true',

  linkedin: {
    clientId: required('LINKEDIN_CLIENT_ID', ''),
    clientSecret: required('LINKEDIN_CLIENT_SECRET', ''),
    redirectUri: required('LINKEDIN_REDIRECT_URI', 'http://localhost:3000/auth/linkedin/callback'),
    // LinkedIn sunsets each monthly API version ~12 months after release, so this default
    // WILL go stale over time (it broke once already — see LINKEDIN_API_VERSION in .env).
    // If posts start failing with "Requested version ... is not active", bump this to a
    // recent YYYYMM — check https://learn.microsoft.com/linkedin/marketing/versioning for
    // the current "Latest Version" table.
    apiVersion: required('LINKEDIN_API_VERSION', '202607'),
  },

  // Fallback only — the Settings page lets the user store their own key in the DB,
  // which takes precedence over this env value at call time.
  geminiApiKeyFallback: required('GEMINI_API_KEY', ''),

  dbPath: path.join(__dirname, '..', '..', 'data', 'app.db'),

  // Opt-in, off by default: only turn this on for a deployment meant to run unattended and
  // auto-update itself from `origin/main` (e.g. a machine you leave running as a server).
  // Left off on a normal dev machine so it never surprises you with an unexpected restart
  // mid-session.
  autoUpdate: {
    enabled: required('AUTO_UPDATE_ENABLED', 'false') === 'true',
    intervalMinutes: Number(required('AUTO_UPDATE_INTERVAL_MINUTES', 30)),
  },
};

function assertLinkedInConfigured() {
  if (!env.linkedin.clientId || !env.linkedin.clientSecret) {
    throw new Error(
      'LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET are not set. Copy .env.example to .env and fill them in ' +
        'from your LinkedIn Developer app before using the /auth/linkedin flow.'
    );
  }
}

module.exports = { env, assertLinkedInConfigured };
