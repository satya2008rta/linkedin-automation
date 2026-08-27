// Storage access layer. Every function here is `async` even though node:sqlite is
// synchronous under the hood — that's deliberate: it means routes/scheduler code already
// speaks the calling convention a future `firebase-admin`/Firestore-backed implementation
// would need, so migrating storage backends later means swapping this file's internals,
// not every caller.
//
// Almost every function below takes a `userId` as its first argument and scopes its query
// to it — this is the multi-user ownership boundary. `getPost`/`getEngagement` filter
// `WHERE id=? AND userId=?` directly in SQL specifically so a post/engagement belonging to
// someone else simply doesn't exist as far as a caller is concerned, rather than relying on
// every route remembering to check ownership itself after a fetch.
const db = require('../config/db');

const nowIso = () => new Date().toISOString();

// node:sqlite's StatementSync.run() throws on any object property that isn't a named
// parameter in the query (unlike better-sqlite3, which silently ignores extras) — so
// merged row objects must be trimmed down to exactly the columns a given statement binds.
function pick(obj, keys) {
  const out = {};
  for (const key of keys) out[key] = obj[key] ?? null;
  return out;
}

// ---- users ----

async function getUserById(id) {
  if (!id) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

async function getUserByPersonUrn(personUrn) {
  if (!personUrn) return null;
  return db.prepare('SELECT * FROM users WHERE personUrn = ?').get(personUrn) || null;
}

async function listAllUsers() {
  return db.prepare('SELECT * FROM users ORDER BY displayName ASC').all();
}

// Claims any posts/engagements/settings left ownerless (userId IS NULL) by the one-time
// singleton->per-user schema migration in config/db.js — real data from before multi-user
// support existed, with no LinkedIn token connected at migration time to attribute it to.
// Only meaningfully does anything the first time it's called (for the very first account
// this app ever has) — see upsertUserFromProfile, the only caller.
async function adoptOrphanedData(userId) {
  db.prepare('UPDATE posts SET userId = ? WHERE userId IS NULL').run(userId);
  db.prepare('UPDATE engagements SET userId = ? WHERE userId IS NULL').run(userId);
  const orphanedSettings = db.prepare('SELECT * FROM settings WHERE userId IS NULL LIMIT 1').get();
  if (orphanedSettings) {
    const alreadyHasOwn = db.prepare('SELECT id FROM settings WHERE userId = ?').get(userId);
    if (!alreadyHasOwn) {
      db.prepare('UPDATE settings SET userId = ? WHERE id = ?').run(userId, orphanedSettings.id);
    }
  }
}

// Resolves the app account for a LinkedIn profile — this is the one place "connect
// LinkedIn" becomes "log into the app" (see auth.routes.js's OAuth callback). Creates a
// user on first sign-in (adopting any pre-existing ownerless data if this is literally the
// first account ever), otherwise just refreshes profile fields + lastLoginAt.
async function upsertUserFromProfile({ personUrn, displayName, email, pictureUrl, headline }) {
  const ts = nowIso();
  const existing = await getUserByPersonUrn(personUrn);
  if (existing) {
    db.prepare(
      `UPDATE users SET displayName=@displayName, email=@email, pictureUrl=@pictureUrl,
         headline=@headline, lastLoginAt=@lastLoginAt WHERE id=@id`
    ).run({
      id: existing.id,
      displayName: displayName ?? null,
      email: email ?? null,
      pictureUrl: pictureUrl ?? null,
      headline: headline ?? null,
      lastLoginAt: ts,
    });
    return { isNewUser: false, user: await getUserById(existing.id) };
  }

  const { c: usersBefore } = db.prepare('SELECT COUNT(*) as c FROM users').get();
  const info = db
    .prepare(
      `INSERT INTO users (personUrn, displayName, email, pictureUrl, headline, createdAt, lastLoginAt)
       VALUES (@personUrn, @displayName, @email, @pictureUrl, @headline, @createdAt, @lastLoginAt)`
    )
    .run({
      personUrn,
      displayName: displayName ?? null,
      email: email ?? null,
      pictureUrl: pictureUrl ?? null,
      headline: headline ?? null,
      createdAt: ts,
      lastLoginAt: ts,
    });
  const user = await getUserById(info.lastInsertRowid);
  if (usersBefore === 0) {
    await adoptOrphanedData(user.id);
  }
  return { isNewUser: true, user };
}

// ---- tokens (one row per user, keyed by userId) ----

async function getToken(userId) {
  if (!userId) return null;
  return db.prepare('SELECT * FROM tokens WHERE userId = ?').get(userId) || null;
}

async function saveToken(userId, token) {
  const existing = await getToken(userId);
  const merged = {
    userId,
    accessToken: token.accessToken ?? existing?.accessToken ?? null,
    tokenType: token.tokenType ?? existing?.tokenType ?? null,
    scope: token.scope ?? existing?.scope ?? null,
    personUrn: token.personUrn ?? existing?.personUrn ?? null,
    displayName: token.displayName ?? existing?.displayName ?? null,
    email: token.email ?? existing?.email ?? null,
    pictureUrl: token.pictureUrl ?? existing?.pictureUrl ?? null,
    headline: token.headline ?? existing?.headline ?? null,
    obtainedAt: token.obtainedAt ?? existing?.obtainedAt ?? nowIso(),
    expiresAt: token.expiresAt ?? existing?.expiresAt ?? null,
    lastAuthAt: token.lastAuthAt ?? nowIso(),
  };
  db.prepare(
    `INSERT INTO tokens (userId, accessToken, tokenType, scope, personUrn, displayName, email, pictureUrl, headline, obtainedAt, expiresAt, lastAuthAt)
     VALUES (@userId, @accessToken, @tokenType, @scope, @personUrn, @displayName, @email, @pictureUrl, @headline, @obtainedAt, @expiresAt, @lastAuthAt)
     ON CONFLICT(userId) DO UPDATE SET
       accessToken=excluded.accessToken, tokenType=excluded.tokenType, scope=excluded.scope,
       personUrn=excluded.personUrn, displayName=excluded.displayName, email=excluded.email,
       pictureUrl=excluded.pictureUrl, headline=excluded.headline, obtainedAt=excluded.obtainedAt,
       expiresAt=excluded.expiresAt, lastAuthAt=excluded.lastAuthAt`
  ).run(merged);
  return getToken(userId);
}

async function clearToken(userId) {
  db.prepare('DELETE FROM tokens WHERE userId = ?').run(userId);
}

async function tokenStatus(userId) {
  const token = await getToken(userId);
  if (!token || !token.accessToken) return { connected: false, expired: true, daysRemaining: 0, token: null };
  const expiresAt = token.expiresAt ? new Date(token.expiresAt) : null;
  const msRemaining = expiresAt ? expiresAt.getTime() - Date.now() : -1;
  const daysRemaining = Math.floor(msRemaining / 86400000);
  return { connected: true, expired: msRemaining <= 0, daysRemaining, token };
}

// ---- settings (one row per user, keyed by userId) ----

async function getSettings(userId) {
  return (
    db.prepare('SELECT * FROM settings WHERE userId = ?').get(userId) || {
      userId,
      geminiApiKey: null,
      aiTopics: null,
      aiTone: null,
      aiAudience: null,
      aiPostsPerWeek: 3,
      aiPreferredTimes: null,
      aiExtraInstructions: null,
    }
  );
}

async function saveSettings(userId, settings) {
  const existing = await getSettings(userId);
  const merged = pick({ ...existing, ...settings }, [
    'geminiApiKey',
    'aiTopics',
    'aiTone',
    'aiAudience',
    'aiPostsPerWeek',
    'aiPreferredTimes',
    'aiExtraInstructions',
  ]);
  merged.userId = userId;
  db.prepare(
    `INSERT INTO settings (userId, geminiApiKey, aiTopics, aiTone, aiAudience, aiPostsPerWeek, aiPreferredTimes, aiExtraInstructions)
     VALUES (@userId, @geminiApiKey, @aiTopics, @aiTone, @aiAudience, @aiPostsPerWeek, @aiPreferredTimes, @aiExtraInstructions)
     ON CONFLICT(userId) DO UPDATE SET
       geminiApiKey=excluded.geminiApiKey, aiTopics=excluded.aiTopics, aiTone=excluded.aiTone,
       aiAudience=excluded.aiAudience, aiPostsPerWeek=excluded.aiPostsPerWeek,
       aiPreferredTimes=excluded.aiPreferredTimes, aiExtraInstructions=excluded.aiExtraInstructions`
  ).run(merged);
  return getSettings(userId);
}

// ---- posts ----

async function createPost(userId, post) {
  const ts = nowIso();
  const info = db
    .prepare(
      `INSERT INTO posts (userId, content, mediaPath, mediaType, visibility, scheduledFor, status, source, authorType, authorUrn, attempts, createdAt, updatedAt)
       VALUES (@userId, @content, @mediaPath, @mediaType, @visibility, @scheduledFor, @status, @source, @authorType, @authorUrn, 0, @createdAt, @updatedAt)`
    )
    .run({
      userId,
      content: post.content,
      mediaPath: post.mediaPath ?? null,
      mediaType: post.mediaType ?? 'none',
      visibility: post.visibility ?? 'PUBLIC',
      scheduledFor: post.scheduledFor ?? null,
      status: post.status ?? 'pending',
      source: post.source ?? 'manual',
      // Who the post goes out as: 'person' (default, your own profile) or 'organization'
      // (a Company Page you administer) — see linkedinOrg.service.js for how pages are
      // discovered. authorUrn is only meaningful when authorType is 'organization'.
      authorType: post.authorType ?? 'person',
      authorUrn: post.authorType === 'organization' ? post.authorUrn ?? null : null,
      createdAt: ts,
      updatedAt: ts,
    });
  return getPost(info.lastInsertRowid, userId);
}

// Ownership-enforced at the SQL level: a post belonging to someone else simply isn't found,
// rather than being fetched and then checked in JS (which is easy to forget to do in some
// route later — see storage.service.js's file header).
async function getPost(id, userId) {
  return db.prepare('SELECT * FROM posts WHERE id = ? AND userId = ?').get(id, userId) || null;
}

async function listPosts(userId, { status, source } = {}) {
  let sql = 'SELECT * FROM posts WHERE userId = ?';
  const params = [userId];
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (source) {
    sql += ' AND source = ?';
    params.push(source);
  }
  sql += ' ORDER BY COALESCE(scheduledFor, createdAt) ASC';
  return db.prepare(sql).all(...params);
}

async function updatePost(id, userId, fields) {
  const existing = await getPost(id, userId);
  if (!existing) return null;
  const merged = pick({ ...existing, ...fields, updatedAt: nowIso() }, [
    'content',
    'mediaPath',
    'mediaType',
    'visibility',
    'scheduledFor',
    'status',
    'source',
    'authorType',
    'authorUrn',
    'attempts',
    'lastError',
    'lockedAt',
    'linkedinPostUrn',
    'linkedinPostUrl',
    'updatedAt',
    'postedAt',
  ]);
  merged.id = id;
  merged.userId = userId;
  // Don't let a stale org URN survive a switch back to posting as yourself.
  if (merged.authorType === 'person') merged.authorUrn = null;
  db.prepare(
    `UPDATE posts SET content=@content, mediaPath=@mediaPath, mediaType=@mediaType, visibility=@visibility,
       scheduledFor=@scheduledFor, status=@status, source=@source, authorType=@authorType, authorUrn=@authorUrn,
       attempts=@attempts, lastError=@lastError,
       lockedAt=@lockedAt, linkedinPostUrn=@linkedinPostUrn, linkedinPostUrl=@linkedinPostUrl,
       updatedAt=@updatedAt, postedAt=@postedAt
     WHERE id=@id AND userId=@userId`
  ).run(merged);
  return getPost(id, userId);
}

async function deletePost(id, userId) {
  db.prepare('DELETE FROM posts WHERE id = ? AND userId = ?').run(id, userId);
}

// Atomically claims up to `limit` due posts (status='pending' AND scheduledFor <= now),
// flipping them to 'posting' with a lock timestamp so a cron overlap or a simultaneous
// manual "Post Now" click can never process the same row twice. Deliberately NOT scoped to
// a single user — this is the scheduler's cross-user work queue, global earliest-due-first
// (per-user fairness is an explicitly out-of-scope future improvement). Each claimed row
// already carries its own `userId` column (SELECT *), which the caller uses to resolve the
// right owner's token before publishing — see postRunner.js.
async function claimDuePosts(limit = 5) {
  const nowStr = nowIso();
  const claimed = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    const due = db
      .prepare(
        `SELECT id FROM posts WHERE status = 'pending' AND scheduledFor IS NOT NULL AND scheduledFor <= ?
         ORDER BY scheduledFor ASC LIMIT ?`
      )
      .all(nowStr, limit);
    for (const row of due) {
      const result = db
        .prepare(
          `UPDATE posts SET status='posting', lockedAt=?, attempts=attempts+1, updatedAt=?
           WHERE id=? AND status='pending'`
        )
        .run(nowStr, nowStr, row.id);
      if (result.changes === 1) {
        claimed.push(db.prepare('SELECT * FROM posts WHERE id = ?').get(row.id));
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return claimed;
}

// Tries to claim one specific post (used by manual "Post Now") — fails silently (returns
// null) if it's not owned by this user, or the scheduler already claimed it first, which is
// the whole point of the guard (also closes the "guess someone else's post id" hole).
async function claimSpecificPost(id, userId) {
  const nowStr = nowIso();
  const result = db
    .prepare(
      `UPDATE posts SET status='posting', lockedAt=?, attempts=attempts+1, updatedAt=?
       WHERE id=? AND userId=? AND status='pending'`
    )
    .run(nowStr, nowStr, id, userId);
  if (result.changes !== 1) return null;
  return db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
}

// Resets any post stuck in 'posting' for longer than `staleMinutes` (covers a process
// crash mid-post) — global sweep, no user scoping needed (a crashed process could have been
// mid-publish for any user's post).
// Deliberately lands on 'failed', NOT back on 'pending'. A post stuck in 'posting' this
// long means the process that claimed it died mid-request (e.g. a server restart) without
// ever finding out whether LinkedIn actually received it — that's genuinely ambiguous, not
// a normal retryable failure. Auto-resetting to 'pending' would let the scheduler silently
// re-attempt it, which risks a duplicate LinkedIn post if the original request had actually
// gone through before the process was killed. Landing on 'failed' instead forces a human to
// check LinkedIn and consciously decide before Retry/Repost Now ever fires again.
async function reapStaleLocks(staleMinutes = 5) {
  const threshold = new Date(Date.now() - staleMinutes * 60000).toISOString();
  const result = db
    .prepare(
      `UPDATE posts SET status='failed', lockedAt=NULL, updatedAt=?,
         lastError='Interrupted mid-publish (likely a server restart) — status on LinkedIn is unknown. Check your profile manually before retrying, to avoid a possible duplicate.'
       WHERE status='posting' AND lockedAt < ?`
    )
    .run(nowIso(), threshold);
  return result.changes;
}

// Cross-user by design, like claimDuePosts/reapStaleLocks above — used only by the
// auto-update checker's "don't restart mid-publish" guard (autoUpdate.js), which cares
// whether ANYONE's post is currently being published, not just one user's.
async function anyPostsWithStatus(status) {
  const row = db.prepare('SELECT COUNT(*) as c FROM posts WHERE status = ?').get(status);
  return row.c > 0;
}

// ---- engagements ----

async function createEngagement(userId, engagement) {
  const ts = nowIso();
  const info = db
    .prepare(
      `INSERT INTO engagements (userId, sourceUrl, activityId, activityUrn, action, commentText, status, createdAt)
       VALUES (@userId, @sourceUrl, @activityId, @activityUrn, @action, @commentText, @status, @createdAt)`
    )
    .run({
      userId,
      sourceUrl: engagement.sourceUrl,
      activityId: engagement.activityId,
      activityUrn: engagement.activityUrn,
      action: engagement.action,
      commentText: engagement.commentText ?? null,
      status: engagement.status ?? 'pending',
      createdAt: ts,
    });
  return getEngagement(info.lastInsertRowid, userId);
}

async function getEngagement(id, userId) {
  return db.prepare('SELECT * FROM engagements WHERE id = ? AND userId = ?').get(id, userId) || null;
}

async function updateEngagement(id, userId, fields) {
  const existing = await getEngagement(id, userId);
  if (!existing) return null;
  const merged = pick({ ...existing, ...fields }, ['status', 'error', 'completedAt']);
  merged.id = id;
  merged.userId = userId;
  db.prepare(
    `UPDATE engagements SET status=@status, error=@error, completedAt=@completedAt WHERE id=@id AND userId=@userId`
  ).run(merged);
  return getEngagement(id, userId);
}

async function listEngagements(userId) {
  return db.prepare('SELECT * FROM engagements WHERE userId = ? ORDER BY createdAt DESC').all(userId);
}

// ---- organizations (Company Pages each user administers) ----

// Wholesale replace (scoped to this user only) rather than upsert-and-diff: the list only
// ever comes from a fresh LinkedIn lookup for that user (reconnect or manual refresh), so
// stale rows (pages they're no longer an admin of) should disappear rather than linger.
async function replaceOrganizations(userId, orgs) {
  const ts = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM organizations WHERE userId = ?').run(userId);
    const insert = db.prepare(
      'INSERT INTO organizations (userId, urn, name, updatedAt) VALUES (@userId, @urn, @name, @updatedAt)'
    );
    for (const org of orgs) {
      insert.run({ userId, urn: org.urn, name: org.name, updatedAt: ts });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

async function listOrganizations(userId) {
  return db.prepare('SELECT * FROM organizations WHERE userId = ? ORDER BY name ASC').all(userId);
}

module.exports = {
  getUserById,
  getUserByPersonUrn,
  listAllUsers,
  upsertUserFromProfile,
  adoptOrphanedData,
  getToken,
  saveToken,
  clearToken,
  tokenStatus,
  getSettings,
  saveSettings,
  createPost,
  getPost,
  listPosts,
  updatePost,
  deletePost,
  claimDuePosts,
  claimSpecificPost,
  reapStaleLocks,
  anyPostsWithStatus,
  createEngagement,
  getEngagement,
  updateEngagement,
  listEngagements,
  replaceOrganizations,
  listOrganizations,
};
