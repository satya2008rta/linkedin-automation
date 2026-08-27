const session = require('express-session');
const db = require('../config/db');

const DEFAULT_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 days, matches server.js's cookie.maxAge

// A minimal express-session Store backed by the same node:sqlite `sessions` table used
// everywhere else in this app — deliberately hand-rolled instead of a package like
// connect-sqlite3, which itself depends on the native `sqlite3` module (the exact
// node-gyp/Python problem this project avoided by using node:sqlite over better-sqlite3
// in the first place). Only get/set/destroy/touch are implemented — the only methods any
// current code path in this app actually needs.
class SqliteSessionStore extends session.Store {
  constructor(options = {}) {
    super();
    this.pruneIntervalMs = options.pruneIntervalMs ?? 15 * 60 * 1000;
    this._prune();
    this._pruneTimer = setInterval(() => this._prune(), this.pruneIntervalMs);
    this._pruneTimer.unref(); // don't keep the process alive just for this
  }

  _prune() {
    try {
      db.prepare('DELETE FROM sessions WHERE expiresAt < ?').run(Date.now());
    } catch (err) {
      // Never let a background prune failure take down the process.
      // eslint-disable-next-line no-console
      console.error('[sqliteSessionStore] prune failed:', err.message);
    }
  }

  _expiresAtFor(sessionData) {
    const maxAge = sessionData?.cookie?.maxAge ?? DEFAULT_MAX_AGE_MS;
    return Date.now() + maxAge;
  }

  get(sid, callback) {
    try {
      const row = db.prepare('SELECT sess, expiresAt FROM sessions WHERE sid = ?').get(sid);
      if (!row || row.expiresAt < Date.now()) return callback(null, null);
      callback(null, JSON.parse(row.sess));
    } catch (err) {
      callback(err);
    }
  }

  set(sid, sessionData, callback) {
    try {
      const sess = JSON.stringify(sessionData);
      const expiresAt = this._expiresAtFor(sessionData);
      db.prepare(
        `INSERT INTO sessions (sid, sess, expiresAt) VALUES (@sid, @sess, @expiresAt)
         ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expiresAt=excluded.expiresAt`
      ).run({ sid, sess, expiresAt });
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  // Required for `rolling: true` sessions (extends expiry on activity) without rewriting
  // the whole session body on every request.
  touch(sid, sessionData, callback) {
    try {
      const expiresAt = this._expiresAtFor(sessionData);
      db.prepare('UPDATE sessions SET expiresAt = ? WHERE sid = ?').run(expiresAt, sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }
}

module.exports = SqliteSessionStore;
