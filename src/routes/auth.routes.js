const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const { assertLinkedInConfigured } = require('../config/env');
const linkedinAuth = require('../services/linkedinAuth.service');
const storage = require('../services/storage.service');
const logger = require('../utils/logger');

router.get('/linkedin', (req, res, next) => {
  try {
    assertLinkedInConfigured();
  } catch (err) {
    req.flash('error', err.message);
    return res.redirect('/settings');
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  res.redirect(linkedinAuth.buildAuthUrl(state));
});

router.get('/linkedin/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;

  if (error) {
    req.flash('error', `LinkedIn denied access: ${errorDescription || error}`);
    return res.redirect('/settings');
  }
  if (!state || state !== req.session.oauthState) {
    req.flash('error', 'OAuth state mismatch — please try connecting again.');
    return res.redirect('/settings');
  }
  req.session.oauthState = null;

  try {
    await linkedinAuth.completeLogin(code);
    req.flash('success', 'LinkedIn account connected.');
  } catch (err) {
    logger.error('OAuth callback failed:', err.response?.data || err.message);
    req.flash('error', `Failed to complete LinkedIn login: ${err.response?.data?.error_description || err.message}`);
  }
  res.redirect('/settings');
});

router.post('/logout', async (req, res) => {
  await storage.clearToken();
  req.flash('success', 'Disconnected from LinkedIn.');
  res.redirect('/settings');
});

// Re-fetches the list of Company Pages you administer using the already-connected token —
// useful after LinkedIn approves a scope or you're added as an admin on a new page, without
// needing a full reconnect. If the current token predates the org scopes entirely, this
// will just come back empty; a full Reconnect is what's actually needed in that case.
router.post('/refresh-organizations', async (req, res) => {
  try {
    const orgs = await linkedinAuth.refreshOrganizations();
    req.flash(
      'success',
      orgs.length > 0
        ? `Found ${orgs.length} company page(s) you administer.`
        : 'No company pages found for the current connection — if you expected some, try Reconnect instead.'
    );
  } catch (err) {
    logger.error('Refresh organizations failed:', err.response?.data || err.message);
    req.flash('error', `Could not refresh company pages: ${err.response?.data?.message || err.message}`);
  }
  res.redirect('/settings');
});

module.exports = router;
