// Storage access layer. Every function here is `async` even though better-sqlite3 is
// synchronous under the hood — that's deliberate: it means routes/scheduler code already
// speaks the calling convention a future `firebase-admin`/Firestore-backed implementation
// would need, so migrating storage backends later means swapping this file's internals,
// not every caller.
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

// ---- tokens (singleton row, id = 1) ----

async function getToken() {
  return db.prepare('SELECT * FROM tokens WHERE id = 1').get() || null;
}

async function saveToken(token) {
  const existing = await getToken();
  const merged = {
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
    `INSERT INTO tokens (id, accessToken, tokenType, scope, personUrn, displayName, email, pictureUrl, headline, obtainedAt, expiresAt, lastAuthAt)
     VALUES (1, @accessToken, @tokenType, @scope, @personUrn, @displayName, @email, @pictureUrl, @headline, @obtainedAt, @expiresAt, @lastAuthAt)
     ON CONFLICT(id) DO UPDATE SET
       accessToken=excluded.accessToken, tokenType=excluded.tokenType, scope=excluded.scope,
       personUrn=excluded.personUrn, displayName=excluded.displayName, email=excluded.email,
       pictureUrl=excluded.pictureUrl, headline=excluded.headline, obtainedAt=excluded.obtainedAt,
       expiresAt=excluded.expiresAt, lastAuthAt=excluded.lastAuthAt`
  ).run(merged);
  return getToken();
}

async function clearToken() {
  db.prepare('DELETE FROM tokens WHERE id = 1').run();
}

async function tokenStatus() {
  const token = await getToken();
  if (!token || !token.accessToken) return { connected: false, expired: true, daysRemaining: 0, token: null };
  const expiresAt = token.expiresAt ? new Date(token.expiresAt) : null;
  const msRemaining = expiresAt ? expiresAt.getTime() - Date.now() : -1;
  const daysRemaining = Math.floor(msRemaining / 86400000);
  return { connected: true, expired: msRemaining <= 0, daysRemaining, token };
}

// ---- settings (singleton row, id = 1) ----

async function getSettings() {
  return (
    db.prepare('SELECT * FROM settings WHERE id = 1').get() || {
      id: 1,
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

async function saveSettings(settings) {
  const existing = await getSettings();
  const merged = pick({ ...existing, ...settings }, [
    'geminiApiKey',
    'aiTopics',
    'aiTone',
    'aiAudience',
    'aiPostsPerWeek',
    'aiPreferredTimes',
    'aiExtraInstructions',
  ]);
  db.prepare(
    `INSERT INTO settings (id, geminiApiKey, aiTopics, aiTone, aiAudience, aiPostsPerWeek, aiPreferredTimes, aiExtraInstructions)
     VALUES (1, @geminiApiKey, @aiTopics, @aiTone, @aiAudience, @aiPostsPerWeek, @aiPreferredTimes, @aiExtraInstructions)
     ON CONFLICT(id) DO UPDATE SET
       geminiApiKey=excluded.geminiApiKey, aiTopics=excluded.aiTopics, aiTone=excluded.aiTone,
       aiAudience=excluded.aiAudience, aiPostsPerWeek=excluded.aiPostsPerWeek,
       aiPreferredTimes=excluded.aiPreferredTimes, aiExtraInstructions=excluded.aiExtraInstructions`
  ).run(merged);
  return getSettings();
}

// ---- posts ----

async function createPost(post) {
  const ts = nowIso();
  const info = db
    .prepare(
      `INSERT INTO posts (content, mediaPath, mediaType, visibility, scheduledFor, status, source, authorType, authorUrn, attempts, createdAt, updatedAt)
       VALUES (@content, @mediaPath, @mediaType, @visibility, @scheduledFor, @status, @source, @authorType, @authorUrn, 0, @createdAt, @updatedAt)`
    )
    .run({
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
  return getPost(info.lastInsertRowid);
}

async function getPost(id) {
  return db.prepare('SELECT * FROM posts WHERE id = ?').get(id) || null;
}

async function listPosts({ status, source } = {}) {
  let sql = 'SELECT * FROM posts WHERE 1=1';
  const params = [];
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

async function updatePost(id, fields) {
  const existing = await getPost(id);
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
  // Don't let a stale org URN survive a switch back to posting as yourself.
  if (merged.authorType === 'person') merged.authorUrn = null;
  db.prepare(
    `UPDATE posts SET content=@content, mediaPath=@mediaPath, mediaType=@mediaType, visibility=@visibility,
       scheduledFor=@scheduledFor, status=@status, source=@source, authorType=@authorType, authorUrn=@authorUrn,
       attempts=@attempts, lastError=@lastError,
       lockedAt=@lockedAt, linkedinPostUrn=@linkedinPostUrn, linkedinPostUrl=@linkedinPostUrl,
       updatedAt=@updatedAt, postedAt=@postedAt
     WHERE id=@id`
  ).run(merged);
  return getPost(id);
}

async function deletePost(id) {
  db.prepare('DELETE FROM posts WHERE id = ?').run(id);
}

// Atomically claims up to `limit` due posts (status='pending' AND scheduledFor <= now),
// flipping them to 'posting' with a lock timestamp so a cron overlap or a simultaneous
// manual "Post Now" click can never process the same row twice. Wrapped in an explicit
// BEGIN/COMMIT (node:sqlite has no `.transaction()` helper like better-sqlite3) — though
// since this is a single Node process making only synchronous DB calls here, the loop
// below is already atomic in practice; the transaction is defense in depth.
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
// null) if the scheduler already claimed it first, which is the whole point of the guard.
async function claimSpecificPost(id) {
  const nowStr = nowIso();
  const result = db
    .prepare(`UPDATE posts SET status='posting', lockedAt=?, attempts=attempts+1, updatedAt=? WHERE id=? AND status='pending'`)
    .run(nowStr, nowStr, id);
  if (result.changes !== 1) return null;
  return getPost(id);
}

// Resets any post stuck in 'posting' for longer than `staleMinutes` (covers a process
// crash mid-post) back to 'pending' so it gets picked up again.
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

// ---- engagements ----

async function createEngagement(engagement) {
  const ts = nowIso();
  const info = db
    .prepare(
      `INSERT INTO engagements (sourceUrl, activityId, activityUrn, action, commentText, status, createdAt)
       VALUES (@sourceUrl, @activityId, @activityUrn, @action, @commentText, @status, @createdAt)`
    )
    .run({
      sourceUrl: engagement.sourceUrl,
      activityId: engagement.activityId,
      activityUrn: engagement.activityUrn,
      action: engagement.action,
      commentText: engagement.commentText ?? null,
      status: engagement.status ?? 'pending',
      createdAt: ts,
    });
  return getEngagement(info.lastInsertRowid);
}

async function getEngagement(id) {
  return db.prepare('SELECT * FROM engagements WHERE id = ?').get(id) || null;
}

async function updateEngagement(id, fields) {
  const existing = await getEngagement(id);
  if (!existing) return null;
  const merged = pick({ ...existing, ...fields }, ['status', 'error', 'completedAt']);
  merged.id = id;
  db.prepare(
    `UPDATE engagements SET status=@status, error=@error, completedAt=@completedAt WHERE id=@id`
  ).run(merged);
  return getEngagement(id);
}

async function listEngagements() {
  return db.prepare('SELECT * FROM engagements ORDER BY createdAt DESC').all();
}

// ---- organizations (Company Pages the connected member administers) ----

// Wholesale replace rather than upsert-and-diff: the list only ever comes from a fresh
// LinkedIn lookup (reconnect or manual refresh), so stale rows (pages you're no longer an
// admin of) should disappear rather than linger.
async function replaceOrganizations(orgs) {
  const ts = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM organizations');
    const insert = db.prepare('INSERT INTO organizations (urn, name, updatedAt) VALUES (@urn, @name, @updatedAt)');
    for (const org of orgs) {
      insert.run({ urn: org.urn, name: org.name, updatedAt: ts });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

async function listOrganizations() {
  return db.prepare('SELECT * FROM organizations ORDER BY name ASC').all();
}

module.exports = {
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
  createEngagement,
  getEngagement,
  updateEngagement,
  listEngagements,
  replaceOrganizations,
  listOrganizations,
};
