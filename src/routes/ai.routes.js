const express = require('express');
const router = express.Router();
const storage = require('../services/storage.service');
const requireValidToken = require('../middleware/requireValidToken');
const gemini = require('../services/gemini.service');
const { localInputToIso } = require('../utils/time');
const logger = require('../utils/logger');

// Shared by /update and /approve: the Calendar page submits Save/Approve/Discard from one
// <form> (via formaction on each button) so edited content/media/schedule is never lost
// just because Approve was clicked instead of Save — both routes need to apply the same
// body fields before doing their own thing.
function editFieldsFromBody(body) {
  const { content, scheduledFor, mediaPath } = body;
  const trimmedMedia = mediaPath && mediaPath.trim() ? mediaPath.trim() : null;
  const fields = { content, mediaPath: trimmedMedia, mediaType: trimmedMedia ? 'image' : 'none' };
  const iso = localInputToIso(scheduledFor);
  if (iso) fields.scheduledFor = iso; // omit entirely rather than pass undefined — see updatePost's spread merge
  return fields;
}

router.post('/settings', async (req, res, next) => {
  try {
    const { geminiApiKey, aiTopics, aiTone, aiAudience, aiPostsPerWeek, aiPreferredTimes, aiExtraInstructions } = req.body;
    const update = { aiTopics, aiTone, aiAudience, aiPostsPerWeek: Number(aiPostsPerWeek) || 3, aiPreferredTimes, aiExtraInstructions };
    // Only overwrite the stored key if the user actually typed a new one — the settings
    // form never re-displays the saved key, so a blank submit shouldn't wipe it out.
    if (geminiApiKey && geminiApiKey.trim()) update.geminiApiKey = geminiApiKey.trim();
    await storage.saveSettings(update);
    req.flash('success', 'AI settings saved.');
    res.redirect('/settings');
  } catch (err) {
    next(err);
  }
});

router.post('/generate-plan', async (req, res) => {
  try {
    const settings = await storage.getSettings();
    const apiKey = gemini.resolveApiKey(settings);
    const token = await storage.getToken();
    const drafts = await gemini.generateMonthlyContentPlan(settings, {
      apiKey,
      displayName: token?.displayName,
      daysAhead: 30,
    });
    for (const draft of drafts) {
      await storage.createPost({
        content: draft.content,
        scheduledFor: draft.scheduledFor,
        status: 'draft',
        source: 'ai',
      });
    }
    req.flash('success', `Generated ${drafts.length} draft posts — review them below before they go live.`);
  } catch (err) {
    logger.error('AI plan generation failed:', err.message);
    req.flash('error', err.message);
  }
  res.redirect('/calendar');
});

router.post('/drafts/:id/update', async (req, res, next) => {
  try {
    await storage.updatePost(Number(req.params.id), editFieldsFromBody(req.body));
    req.flash('success', 'Draft updated.');
    res.redirect('/calendar');
  } catch (err) {
    next(err);
  }
});

router.post('/drafts/:id/approve', requireValidToken, async (req, res, next) => {
  try {
    const post = await storage.getPost(Number(req.params.id));
    if (!post || post.status !== 'draft') {
      req.flash('error', 'Draft not found.');
      return res.redirect('/calendar');
    }
    // Apply whatever's currently in the form (including any unsaved edit) before flipping
    // status, so Approve reflects what's on screen right now, not the last-saved version.
    await storage.updatePost(post.id, { ...editFieldsFromBody(req.body), status: 'pending' });
    req.flash('success', 'Approved — it will publish at its scheduled time.');
    res.redirect('/calendar');
  } catch (err) {
    next(err);
  }
});

router.post('/drafts/:id/discard', async (req, res, next) => {
  try {
    await storage.deletePost(Number(req.params.id));
    req.flash('success', 'Draft discarded.');
    res.redirect('/calendar');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
