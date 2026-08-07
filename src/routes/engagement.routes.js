const express = require('express');
const router = express.Router();
const storage = require('../services/storage.service');
const requireValidToken = require('../middleware/requireValidToken');
const linkedinEngagement = require('../services/linkedinEngagement.service');
const { parseActivityUrnFromUrl, UrnParseError } = require('../utils/urn');
const logger = require('../utils/logger');

router.post('/', requireValidToken, async (req, res) => {
  const { sourceUrl, doLike, commentText } = req.body;
  const wantLike = doLike === 'on';
  const wantComment = Boolean(commentText && commentText.trim());

  if (!wantLike && !wantComment) {
    req.flash('error', 'Choose Like and/or write a comment.');
    return res.redirect('/engage');
  }

  let parsed;
  try {
    parsed = parseActivityUrnFromUrl(sourceUrl);
  } catch (err) {
    if (err instanceof UrnParseError) {
      req.flash('error', err.message);
      return res.redirect('/engage');
    }
    throw err;
  }

  const action = wantLike && wantComment ? 'like+comment' : wantLike ? 'like' : 'comment';
  const engagement = await storage.createEngagement({
    sourceUrl,
    activityId: parsed.id,
    activityUrn: parsed.urn,
    action,
    commentText: wantComment ? commentText.trim() : null,
    status: 'processing',
  });

  const token = req.tokenStatus.token;
  const errors = [];
  if (wantLike) {
    try {
      await linkedinEngagement.likePost(parsed.urn, token.personUrn, token.accessToken);
    } catch (err) {
      errors.push(`Like failed: ${err.response?.data?.message || err.message}`);
    }
  }
  if (wantComment) {
    try {
      await linkedinEngagement.commentOnPost(parsed.urn, token.personUrn, commentText.trim(), token.accessToken);
    } catch (err) {
      errors.push(`Comment failed: ${err.response?.data?.message || err.message}`);
    }
  }

  if (errors.length) {
    logger.error('Engagement failed:', errors.join(' | '));
    await storage.updateEngagement(engagement.id, { status: 'failed', error: errors.join(' | ') });
    req.flash('error', errors.join(' '));
  } else {
    await storage.updateEngagement(engagement.id, { status: 'done', completedAt: new Date().toISOString() });
    req.flash('success', 'Done — check the post on LinkedIn.');
  }
  res.redirect('/engage');
});

module.exports = router;
