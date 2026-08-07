const fs = require('fs');
const path = require('path');
// Node's built-in SQLite module (stable since Node 22.5+, no flag needed on this Node version).
// Deliberately used instead of `better-sqlite3` here: better-sqlite3 ships prebuilt binaries
// that lag behind newer Node ABI versions and falls back to a native (node-gyp/Python) build,
// which this machine doesn't have set up. node:sqlite gives the same synchronous, in-process
// API with zero native-compile risk.
const { DatabaseSync } = require('node:sqlite');
const { env } = require('./env');

fs.mkdirSync(path.dirname(env.dbPath), { recursive: true });

const db = new DatabaseSync(env.dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY CHECK (id = 1),
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
  content TEXT NOT NULL,
  mediaPath TEXT,
  mediaType TEXT NOT NULL DEFAULT 'none',
  visibility TEXT NOT NULL DEFAULT 'PUBLIC',
  scheduledFor TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  source TEXT NOT NULL DEFAULT 'manual',
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

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  geminiApiKey TEXT,
  aiTopics TEXT,
  aiTone TEXT,
  aiAudience TEXT,
  aiPostsPerWeek INTEGER DEFAULT 3,
  aiPreferredTimes TEXT,
  aiExtraInstructions TEXT
);
`;

db.exec(SCHEMA);

module.exports = db;
