const fs = require('fs');
const path = require('path');
// Node's built-in SQLite module (stable since Node 22.5+, no flag needed on this Node version).
// Deliberately used instead of `better-sqlite3` here: better-sqlite3 ships prebuilt binaries
// that lag behind newer Node ABI versions and falls back to a native (node-gyp/Python) build,
// which this machine doesn't have set up. node:sqlite gives the same synchronous, in-process
// API with zero native-compile risk. Also why session storage is a hand-rolled table (see
// sqliteSessionStore.js) rather than a package like connect-sqlite3, which itself depends on
// the native `sqlite3` module — same problem, different door.
const { DatabaseSync } = require('node:sqlite');
const { env } = require('./env');

fs.mkdirSync(path.dirname(env.dbPath), { recursive: true });

const db = new DatabaseSync(env.dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// This is the FINAL desired shape — correct for a brand-new install where CREATE TABLE IF
// NOT EXISTS just creates everything once, in one pass. An EXISTING database created by an
// older version of this file will already have `tokens`/`settings`/`organizations` in their
// old single-tenant shape (IF NOT EXISTS is a no-op against an existing table of that name,
// it does not reconcile columns/constraints) — the migration block below detects and upgrades
// that case, preserving every row.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  personUrn TEXT UNIQUE NOT NULL,
  displayName TEXT,
  email TEXT,
  pictureUrl TEXT,
  headline TEXT,
  createdAt TEXT NOT NULL,
  lastLoginAt TEXT NOT NULL
);

-- Backs the custom express-session Store in services/sqliteSessionStore.js.
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expiresAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expiresAt);

CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId INTEGER NOT NULL UNIQUE REFERENCES users(id),
  accessToken TEXT,
  tokenType TEXT,
  scope TEXT,
  personUrn TEXT,
  displayName TEXT,
  email TEXT,
  pictureUrl TEXT,
  headline TEXT,
  obtainedAt TEXT,
  expiresAt TEXT,
  lastAuthAt TEXT
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId INTEGER REFERENCES users(id),
  content TEXT NOT NULL,
  mediaPath TEXT,
  mediaType TEXT NOT NULL DEFAULT 'none',
  visibility TEXT NOT NULL DEFAULT 'PUBLIC',
  scheduledFor TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  source TEXT NOT NULL DEFAULT 'manual',
  authorType TEXT NOT NULL DEFAULT 'person',
  authorUrn TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lastError TEXT,
  lockedAt TEXT,
  linkedinPostUrn TEXT,
  linkedinPostUrl TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  postedAt TEXT
);

CREATE INDEX IF NOT EXISTS idx_posts_status_scheduled ON posts (status, scheduledFor);

CREATE TABLE IF NOT EXISTS engagements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId INTEGER REFERENCES users(id),
  sourceUrl TEXT NOT NULL,
  activityId TEXT NOT NULL,
  activityUrn TEXT NOT NULL,
  action TEXT NOT NULL,
  commentText TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  createdAt TEXT NOT NULL,
  completedAt TEXT
);

-- userId is nullable here (unlike tokens' NOT NULL) specifically so a settings row orphaned
-- by the one-time singleton->per-user migration below (real configured Gemini key/AI prefs
-- with no owner yet, because no one was signed in when this migration ran) can be preserved
-- and later adopted by the first person to sign in, rather than being discarded.
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId INTEGER UNIQUE REFERENCES users(id),
  geminiApiKey TEXT,
  aiTopics TEXT,
  aiTone TEXT,
  aiAudience TEXT,
  aiPostsPerWeek INTEGER DEFAULT 3,
  aiPreferredTimes TEXT,
  aiExtraInstructions TEXT
);

-- Company Pages each user administers (refreshed on their reconnect / manual refresh).
CREATE TABLE IF NOT EXISTS organizations (
  userId INTEGER NOT NULL REFERENCES users(id),
  urn TEXT NOT NULL,
  name TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (userId, urn)
);
`;

db.exec(SCHEMA);

// ---- One-time migration: upgrade an existing single-tenant database in place ----
// Detected by checking whether `tokens` already has a `userId` column — if it does, either
// this is a fresh install (SCHEMA above already created it correctly) or the migration
// already ran on a previous boot. If it doesn't, `tokens` is in the old CHECK(id=1)
// singleton shape and needs rebuilding, taking `settings`/`organizations`/`posts`/
// `engagements` along with it in the same transaction.
const tokensColumns = db.prepare('PRAGMA table_info(tokens)').all().map((c) => c.name);
const needsMultiUserMigration = !tokensColumns.includes('userId');

if (needsMultiUserMigration) {
  db.exec('BEGIN IMMEDIATE');
  try {
    // tokens: old shape had no `userId` and a real row's identity was the only place a
    // "first user" could be seeded from. Preserve it if present.
    const existingToken = db.prepare('SELECT * FROM tokens WHERE id = 1').get();
    let firstUserId = null;
    if (existingToken && existingToken.personUrn) {
      const nowIso = new Date().toISOString();
      const info = db
        .prepare(
          `INSERT INTO users (personUrn, displayName, email, pictureUrl, headline, createdAt, lastLoginAt)
           VALUES (@personUrn, @displayName, @email, @pictureUrl, @headline, @createdAt, @lastLoginAt)`
        )
        .run({
          personUrn: existingToken.personUrn,
          displayName: existingToken.displayName ?? null,
          email: existingToken.email ?? null,
          pictureUrl: existingToken.pictureUrl ?? null,
          headline: existingToken.headline ?? null,
          createdAt: existingToken.obtainedAt || nowIso,
          lastLoginAt: existingToken.lastAuthAt || nowIso,
        });
      firstUserId = info.lastInsertRowid;
    }

    db.exec('ALTER TABLE tokens RENAME TO tokens_old');
    db.exec(`CREATE TABLE tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL UNIQUE REFERENCES users(id),
      accessToken TEXT, tokenType TEXT, scope TEXT, personUrn TEXT, displayName TEXT,
      email TEXT, pictureUrl TEXT, headline TEXT, obtainedAt TEXT, expiresAt TEXT, lastAuthAt TEXT
    )`);
    if (firstUserId && existingToken && existingToken.accessToken) {
      db.prepare(
        `INSERT INTO tokens (userId, accessToken, tokenType, scope, personUrn, displayName,
           email, pictureUrl, headline, obtainedAt, expiresAt, lastAuthAt)
         SELECT ?, accessToken, tokenType, scope, personUrn, displayName,
           email, pictureUrl, headline, obtainedAt, expiresAt, lastAuthAt
         FROM tokens_old WHERE id = 1`
      ).run(firstUserId);
    }
    db.exec('DROP TABLE tokens_old');

    // settings: preserve the existing singleton row (real Gemini key / AI prefs) even if
    // firstUserId is null (no token was connected when this migration ran) — left as an
    // owner-less row for the first real sign-in to adopt, rather than discarded.
    const existingSettings = db.prepare('SELECT * FROM settings WHERE id = 1').get();
    db.exec('ALTER TABLE settings RENAME TO settings_old');
    db.exec(`CREATE TABLE settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER UNIQUE REFERENCES users(id),
      geminiApiKey TEXT, aiTopics TEXT, aiTone TEXT, aiAudience TEXT,
      aiPostsPerWeek INTEGER DEFAULT 3, aiPreferredTimes TEXT, aiExtraInstructions TEXT
    )`);
    if (existingSettings) {
      db.prepare(
        `INSERT INTO settings (userId, geminiApiKey, aiTopics, aiTone, aiAudience,
           aiPostsPerWeek, aiPreferredTimes, aiExtraInstructions)
         VALUES (@userId, @geminiApiKey, @aiTopics, @aiTone, @aiAudience,
           @aiPostsPerWeek, @aiPreferredTimes, @aiExtraInstructions)`
      ).run({
        userId: firstUserId,
        geminiApiKey: existingSettings.geminiApiKey,
        aiTopics: existingSettings.aiTopics,
        aiTone: existingSettings.aiTone,
        aiAudience: existingSettings.aiAudience,
        aiPostsPerWeek: existingSettings.aiPostsPerWeek,
        aiPreferredTimes: existingSettings.aiPreferredTimes,
        aiExtraInstructions: existingSettings.aiExtraInstructions,
      });
    }
    db.exec('DROP TABLE settings_old');

    // organizations: old shape had `urn` as the sole primary key (one global list). Move to
    // a composite (userId, urn) key. Rows are re-fetched from LinkedIn on next reconnect
    // anyway (see linkedinOrg.service.js), so this is a structural-only migration — carry
    // rows over attributed to firstUserId if we have one, otherwise they're just dropped
    // (a "Refresh company pages" click after signing in regenerates them for free).
    const existingOrgs = firstUserId ? db.prepare('SELECT * FROM organizations').all() : [];
    db.exec('ALTER TABLE organizations RENAME TO organizations_old');
    db.exec(`CREATE TABLE organizations (
      userId INTEGER NOT NULL REFERENCES users(id),
      urn TEXT NOT NULL,
      name TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      PRIMARY KEY (userId, urn)
    )`);
    if (firstUserId) {
      const insertOrg = db.prepare(
        'INSERT INTO organizations (userId, urn, name, updatedAt) VALUES (?, ?, ?, ?)'
      );
      for (const org of existingOrgs) {
        insertOrg.run(firstUserId, org.urn, org.name, org.updatedAt);
      }
    }
    db.exec('DROP TABLE organizations_old');

    // posts / engagements: plain ADD COLUMN (already-collection tables, no constraint
    // change needed) + backfill to firstUserId where we have one. Any row left with
    // userId IS NULL after this (the common case right now, since no token was connected)
    // is adopted by the first person to sign in post-migration — see
    // storage.service.js's adoptOrphanedData(), called once from the OAuth callback.
    db.exec('ALTER TABLE posts ADD COLUMN userId INTEGER REFERENCES users(id)');
    db.exec('ALTER TABLE engagements ADD COLUMN userId INTEGER REFERENCES users(id)');
    // authorType/authorUrn: added by an earlier migration already, before multi-user existed
    // — the defensive "older column-only migrations" block further down handles adding them
    // for anyone even further behind, so nothing to do for those two columns here.
    if (firstUserId) {
      db.prepare('UPDATE posts SET userId = ? WHERE userId IS NULL').run(firstUserId);
      db.prepare('UPDATE engagements SET userId = ? WHERE userId IS NULL').run(firstUserId);
    }
    // (userId-based indexes are created unconditionally just after this block, once we
    // know for certain the column exists either way.)

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Safe unconditionally at this point: posts/engagements definitely have `userId` now,
// either from the base SCHEMA (fresh install) or the migration block above (upgraded DB).
db.exec('CREATE INDEX IF NOT EXISTS idx_posts_user_status_scheduled ON posts (userId, status, scheduledFor)');
db.exec('CREATE INDEX IF NOT EXISTS idx_engagements_user ON engagements (userId)');

// Older column-only migrations (pre-dates the multi-user migration above; a no-op once
// SCHEMA or the migration above has already created these columns, kept for anyone
// upgrading from a version of this app that predates even the authorType/authorUrn columns).
const postsColumns = db.prepare('PRAGMA table_info(posts)').all().map((c) => c.name);
if (!postsColumns.includes('authorType')) {
  db.exec("ALTER TABLE posts ADD COLUMN authorType TEXT NOT NULL DEFAULT 'person'");
}
if (!postsColumns.includes('authorUrn')) {
  db.exec('ALTER TABLE posts ADD COLUMN authorUrn TEXT');
}

module.exports = db;
