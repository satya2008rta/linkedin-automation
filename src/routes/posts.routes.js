const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const storage = require('../services/storage.service');
const requireValidToken = require('../middleware/requireValidToken');
const postRunner = require('../scheduler/postRunner');
const { localInputToIso, autoSpaceTargetTime } = require('../utils/time');
const { validateLocalImage, MediaValidationError } = require('../services/media.service');
const logger = require('../utils/logger');

// A queued post can only be edited before it's gone out — once the scheduler has claimed
// it ('posting') or it's already live ('posted'), editing the local record wouldn't change
// what's actually on LinkedIn, so it's blocked both in the UI and here server-side.
const EDITABLE_STATUSES = new Set(['pending', 'failed', 'blocked_token_expired']);

const UPLOADS_ROOT = path.join(process.cwd(), 'data', 'uploads');

// Shared by /update and /retry: the Queue page submits Save/Retry/Cancel from one <form>
// (via formaction on each button) so an edit is never lost just because Retry was clicked
// instead of Save — both routes need to apply the same body fields before doing their own
// thing. Returns null if content is blank, which callers treat as a validation failure.
function editFieldsFromBody(body) {
  const { content, mediaPath, visibility, scheduledFor, authorUrn } = body;
  if (!content || !content.trim()) return null;
  const trimmedMedia = mediaPath && mediaPath.trim() ? mediaPath.trim() : null;
  const fields = {
    content: content.trim(),
    mediaPath: trimmedMedia,
    mediaType: trimmedMedia ? 'image' : 'none',
    visibility: visibility || 'PUBLIC',
    // "Post as" select sends either "person" or an org URN as its value — see compose.ejs/
    // queue.ejs. Empty/"person" means posting as yourself.
    authorType: authorUrn && authorUrn.trim() ? 'organization' : 'person',
    authorUrn: authorUrn && authorUrn.trim() ? authorUrn.trim() : null,
  };
  const iso = localInputToIso(scheduledFor);
  if (iso) fields.scheduledFor = iso; // omit rather than pass undefined — see updatePost's spread merge
  return fields;
}

// Streams a local desktop image back to the browser so the compose/calendar preview can
// display it — a plain <img src="file://..."> is blocked by most browsers when the page
// itself was loaded over http, so the preview has to go through the server instead.
//
// mediaPath can legitimately be ANY absolute path on the machine this server runs on (the
// whole point of the plain-text field is reading a file at post time, not uploading it
// immediately) — so this deliberately does NOT restrict every request to the caller's own
// upload folder. The one path that DOES need an ownership check is anything living under
// data/uploads/, since that's where per-user uploaded files land and — unlike an arbitrary
// desktop path only the machine's owner would know — another signed-in user could simply
// guess or reuse one of those paths to preview someone else's uploaded image.
router.get('/media-preview', (req, res) => {
  const filePath = req.query.path;
  try {
    if (filePath) {
      const resolved = path.resolve(filePath);
      const uploadsResolved = path.resolve(UPLOADS_ROOT);
      if (resolved.startsWith(uploadsResolved + path.sep)) {
        const ownDir = path.resolve(UPLOADS_ROOT, String(req.activeUserId));
        if (!resolved.startsWith(ownDir + path.sep)) {
          return res.status(404).end();
        }
      }
    }
    const { mimeType } = validateLocalImage(filePath);
    res.setHeader('Content-Type', mimeType);
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    if (err instanceof MediaValidationError) return res.status(404).end();
    throw err;
  }
});

// Uploads a local image file directly from the browser file chooser into
// data/uploads/<userId>/ (namespaced per user) and returns the real absolute path on disk
// so mediaPath is populated cleanly and reliably.
router.post('/upload-media', express.json({ limit: '30mb' }), (req, res) => {
  try {
    const { filename, base64Data } = req.body;
    if (!filename || !base64Data) {
      return res.status(400).json({ error: 'Filename and base64Data required.' });
    }
    const uploadsDir = path.join(UPLOADS_ROOT, String(req.activeUserId));
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    const safeName = `${Date.now()}_${path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const targetPath = path.join(uploadsDir, safeName);
    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(targetPath, buffer);
    res.json({ path: targetPath });
  } catch (err) {
    logger.error('Upload media failed:', err);
    res.status(500).json({ error: 'Failed to save media file.' });
  }
});

// Create a post — either scheduled for later, or published immediately ("Post Now").
router.post('/', requireValidToken, async (req, res, next) => {
  try {
    const userId = req.activeUserId;
    const { content, mediaPath, visibility, scheduledFor, action, authorUrn } = req.body;
    if (!content || !content.trim()) {
      req.flash('error', 'Post content cannot be empty.');
      return res.redirect('/compose');
    }

    const mediaType = mediaPath && mediaPath.trim() ? 'image' : 'none';
    const isNow = action === 'now';
    const scheduledIso = isNow ? new Date().toISOString() : localInputToIso(scheduledFor);

    if (!isNow && !scheduledIso) {
      req.flash('error', 'Pick a valid date/time to schedule this post, or use "Post Now" instead.');
      return res.redirect('/compose');
    }

    const post = await storage.createPost(userId, {
      content: content.trim(),
      mediaPath: mediaPath && mediaPath.trim() ? mediaPath.trim() : null,
      mediaType,
      visibility: visibility || 'PUBLIC',
      scheduledFor: scheduledIso,
      status: 'pending',
      source: 'manual',
      // "Post as" select on Compose sends either empty ("post as yourself") or an org URN.
      authorType: authorUrn && authorUrn.trim() ? 'organization' : 'person',
      authorUrn: authorUrn && authorUrn.trim() ? authorUrn.trim() : null,
    });

    if (isNow) {
      const result = await postRunner.postNow(post.id, userId);
      if (result.status === 'posted') {
        req.flash('success', `Posted to LinkedIn: ${result.linkedinPostUrl || ''}`);
      } else {
        req.flash('error', `Post did not go through: ${result.lastError || 'unknown error'}`);
      }
    } else {
      req.flash('success', 'Post scheduled.');
    }
    res.redirect('/queue');
  } catch (err) {
    logger.error('Create post failed:', err.response?.data || err.message);
    req.flash('error', `Could not create post: ${err.response?.data?.message || err.message}`);
    res.redirect('/compose');
  }
});

// Edit a queued post's content/media/schedule/visibility before it goes out.
router.post('/:id/update', async (req, res, next) => {
  try {
    const userId = req.activeUserId;
    const post = await storage.getPost(Number(req.params.id), userId);
    if (!post) {
      req.flash('error', 'Post not found.');
      return res.redirect('/queue');
    }
    if (!EDITABLE_STATUSES.has(post.status)) {
      req.flash('error', `This post is "${post.status.replace('_', ' ')}" and can no longer be edited.`);
      return res.redirect('/queue');
    }

    const fields = editFieldsFromBody(req.body);
    if (!fields) {
      req.flash('error', 'Post content cannot be empty.');
      return res.redirect(`/queue#post-${post.id}`);
    }

    await storage.updatePost(post.id, userId, fields);
    req.flash('success', 'Post updated.');
    // #post-<id> anchor so the page scrolls back to this card instead of jumping to the
    // top of the queue — otherwise every save loses your place in a long list.
    res.redirect(`/queue#post-${post.id}`);
  } catch (err) {
    next(err);
  }
});

// Manually resume a post that's stuck in 'failed' or 'blocked_token_expired'. Also applies
// whatever's currently in the Queue edit form (see editFieldsFromBody), so fixing a typo
// and clicking Retry in one step actually saves the fix instead of silently discarding it.
router.post('/:id/retry', requireValidToken, async (req, res, next) => {
  try {
    const userId = req.activeUserId;
    const post = await storage.getPost(Number(req.params.id), userId);
    if (!post) {
      req.flash('error', 'Post not found.');
      return res.redirect('/queue');
    }
    const fields = editFieldsFromBody(req.body);
    if (!fields) {
      req.flash('error', 'Post content cannot be empty.');
      return res.redirect(`/queue#post-${post.id}`);
    }
    if (!fields.scheduledFor) {
      fields.scheduledFor = post.scheduledFor && new Date(post.scheduledFor) > new Date() ? post.scheduledFor : new Date().toISOString();
    }
    await storage.updatePost(post.id, userId, { ...fields, status: 'pending', attempts: 0, lastError: null, lockedAt: null });
    req.flash('success', 'Post requeued for its scheduled time — the scheduler will pick it up within a minute, or use "Repost Now" for an immediate attempt.');
    res.redirect(`/queue#post-${post.id}`);
  } catch (err) {
    next(err);
  }
});

// Immediately publish an editable queued post right now ('pending', 'failed', or 'blocked_token_expired'),
// rather than waiting for the scheduled time or cron tick. Applies any pending edits in the Queue form first.
async function handlePostNow(req, res, next) {
  try {
    const userId = req.activeUserId;
    const post = await storage.getPost(Number(req.params.id), userId);
    if (!post) {
      req.flash('error', 'Post not found.');
      return res.redirect('/queue');
    }
    if (!EDITABLE_STATUSES.has(post.status)) {
      req.flash('error', `This post is "${post.status.replace('_', ' ')}" and cannot be published right now.`);
      return res.redirect('/queue');
    }
    const fields = editFieldsFromBody(req.body);
    if (!fields) {
      req.flash('error', 'Post content cannot be empty.');
      return res.redirect(`/queue#post-${post.id}`);
    }
    await storage.updatePost(post.id, userId, {
      ...fields,
      scheduledFor: new Date().toISOString(),
      status: 'pending',
      attempts: 0,
      lastError: null,
      lockedAt: null,
    });
    const result = await postRunner.postNow(post.id, userId);
    if (result.status === 'posted') {
      req.flash('success', `Posted to LinkedIn: ${result.linkedinPostUrl || ''}`);
    } else {
      req.flash('error', `Post did not go through: ${result.lastError || 'unknown error'}`);
    }
    // If it succeeded, the post is no longer in the queue list at all (moved to /posted),
    // so the anchor just harmlessly doesn't match anything — no special-casing needed.
    res.redirect(`/queue#post-${post.id}`);
  } catch (err) {
    next(err);
  }
}

router.post('/:id/post-now', requireValidToken, handlePostNow);
router.post('/:id/repost-now', requireValidToken, handlePostNow);

// Cancel a post that hasn't gone out yet.
router.post('/:id/cancel', async (req, res, next) => {
  try {
    const userId = req.activeUserId;
    const post = await storage.getPost(Number(req.params.id), userId);
    if (!post) {
      req.flash('error', 'Post not found.');
      return res.redirect('/queue');
    }
    if (post.status === 'posted') {
      req.flash('error', 'This post has already been published to LinkedIn and cannot be cancelled from here.');
      return res.redirect('/queue');
    }
    await storage.deletePost(post.id, userId);
    req.flash('success', 'Post cancelled.');
    res.redirect('/queue');
  } catch (err) {
    next(err);
  }
});

// Reschedule a post's date while preserving its original posting time.
router.post('/:id/reschedule-date', async (req, res, next) => {
  try {
    const userId = req.activeUserId;
    const { newDate } = req.body; // format YYYY-MM-DD
    if (!newDate || !/^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
      return res.status(400).json({ error: 'Valid newDate (YYYY-MM-DD) required.' });
    }

    const post = await storage.getPost(Number(req.params.id), userId);
    if (!post) {
      return res.status(404).json({ error: 'Post not found.' });
    }

    // Determine original time (hours, minutes, seconds)
    const baseDateStr = post.scheduledFor || post.postedAt || post.createdAt || new Date().toISOString();
    const origDate = new Date(baseDateStr);

    const [y, m, d] = newDate.split('-').map(Number);
    const targetDate = new Date(origDate);
    targetDate.setFullYear(y, m - 1, d);

    const newScheduledIso = targetDate.toISOString();

    const allPosts = await storage.listPosts(userId, {});
    const existingOnTargetDay = allPosts.filter((p) => {
      if (p.id === post.id) return false;
      const pDate = p.scheduledFor || p.postedAt || p.createdAt;
      return pDate && pDate.slice(0, 10) === newDate;
    });

    const finalScheduledIso = autoSpaceTargetTime(newScheduledIso, existingOnTargetDay, post.id);

    const updated = await storage.updatePost(post.id, userId, {
      scheduledFor: finalScheduledIso,
    });

    res.json({ ok: true, post: updated, newScheduledFor: finalScheduledIso });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
