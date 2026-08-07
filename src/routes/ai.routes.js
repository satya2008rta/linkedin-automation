const express = require('express');
const router = express.Router();
const storage = require('../services/storage.service');
const requireValidToken = require('../middleware/requireValidToken');
const gemini = require('../services/gemini.service');
const { localInputToIso, autoSpaceTargetTime } = require('../utils/time');
const logger = require('../utils/logger');

function editFieldsFromBody(body) {
  if (!body) return {};
  const fields = {};
  if (body.content !== undefined && body.content !== null && body.content.trim() !== '') {
    fields.content = body.content.trim();
  }
  if (body.mediaPath !== undefined && body.mediaPath !== null) {
    const trimmedMedia = body.mediaPath.trim() ? body.mediaPath.trim() : null;
    fields.mediaPath = trimmedMedia;
    fields.mediaType = trimmedMedia ? 'image' : 'none';
  }
  if (body.scheduledFor) {
    const iso = localInputToIso(body.scheduledFor);
    if (iso) fields.scheduledFor = iso;
  }
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
    const { fromDate, toDate } = req.body;
    const settings = await storage.getSettings();
    const apiKey = gemini.resolveApiKey(settings);
    const token = await storage.getToken();
    const drafts = await gemini.generateMonthlyContentPlan(settings, {
      apiKey,
      displayName: token?.displayName,
      fromDate: fromDate && fromDate.trim() ? fromDate.trim() : null,
      toDate: toDate && toDate.trim() ? toDate.trim() : null,
    });

    const allExisting = await storage.listPosts({});

    for (const draft of drafts) {
      const draftDateStr = draft.scheduledFor ? draft.scheduledFor.slice(0, 10) : '';
      const existingOnDay = allExisting.filter((p) => {
        const pDate = p.scheduledFor || p.postedAt || p.createdAt;
        return pDate && pDate.slice(0, 10) === draftDateStr;
      });

      const autoScheduledFor = autoSpaceTargetTime(draft.scheduledFor, existingOnDay);

      const created = await storage.createPost({
        content: draft.content,
        scheduledFor: autoScheduledFor,
        status: 'draft',
        source: 'ai',
      });
      allExisting.push(created);
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
    const fields = editFieldsFromBody(req.body);
    if (Object.keys(fields).length > 0) {
      await storage.updatePost(Number(req.params.id), fields);
    }
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
    const fields = editFieldsFromBody(req.body);
    const finalContent = fields.content || post.content;
    if (!finalContent || !finalContent.trim()) {
      req.flash('error', 'Post content cannot be empty.');
      return res.redirect('/calendar');
    }

    await storage.updatePost(post.id, {
      ...fields,
      content: finalContent,
      status: 'pending',
    });
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
