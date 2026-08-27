const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const { env, assertLinkedInConfigured } = require('../config/env');
const linkedinAuth = require('../services/linkedinAuth.service');
const storage = require('../services/storage.service');
const logger = require('../utils/logger');

// HMAC signature helpers for shareable invite links
function createInviteSig(exp) {
  return crypto.createHmac('sha256', env.sessionSecret).update(`invite:${exp}`).digest('hex');
}

function verifyInviteSig(exp, sig) {
  if (!exp || !sig) return false;
  const expNum = Number(exp);
  if (isNaN(expNum) || Date.now() > expNum) return false;
  const expectedSig = createInviteSig(exp);
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig));
  } catch {
    return false;
  }
}

// Generate shareable invite link page for admin
router.get('/invite-link', async (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  const currentUser = await storage.getUserById(req.session.userId);
  if (!currentUser || (currentUser.email || '').toLowerCase() !== env.adminEmail) {
    req.flash('error', 'Only the admin can generate invite links.');
    return res.redirect('/');
  }

  // Generate 24-hour invite link
  const exp = Date.now() + 24 * 60 * 60 * 1000;
  const sig = createInviteSig(exp);
  const inviteUrl = `${env.appBaseUrl}/auth/linkedin?mode=invite&exp=${exp}&sig=${sig}`;

  res.render('invite', {
    title: 'Invite Client',
    active: '',
    inviteUrl,
    expiresAt: new Date(exp).toLocaleString(),
  });
});

// Switch active user context (Admin only)
router.post('/switch-user', async (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  const currentUser = await storage.getUserById(req.session.userId);
  if (!currentUser || (currentUser.email || '').toLowerCase() !== env.adminEmail) {
    req.flash('error', 'Unauthorized to switch users.');
    return res.redirect('/');
  }

  const { targetUserId } = req.body;
  if (!targetUserId) {
    delete req.session.activeUserId;
    req.flash('success', 'Switched back to Admin profile.');
    return res.redirect(req.headers.referer || '/');
  }

  const targetUser = await storage.getUserById(Number(targetUserId));
  if (!targetUser) {
    req.flash('error', 'Selected user not found.');
    return res.redirect(req.headers.referer || '/');
  }

  req.session.activeUserId = targetUser.id;
  req.flash('success', `Now acting as ${targetUser.displayName || targetUser.email || 'User #' + targetUser.id}.`);
  res.redirect(req.headers.referer || '/');
});

// Initiates OAuth flow (for admin or via invite link)
router.get('/linkedin', (req, res) => {
  try {
    assertLinkedInConfigured();
  } catch (err) {
    req.flash('error', err.message);
    return res.redirect(req.session.userId ? '/settings' : '/login');
  }

  const { mode, exp, sig } = req.query;
  if (mode === 'invite') {
    if (!verifyInviteSig(exp, sig)) {
      req.flash('error', 'This invite link is invalid or has expired. Please ask the administrator for a new link.');
      return res.redirect('/login');
    }
    req.session.oauthMode = 'invite';
  } else {
    req.session.oauthMode = 'login';
  }

  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  res.redirect(linkedinAuth.buildAuthUrl(state));
});

router.get('/linkedin/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;
  const isInviteMode = req.session.oauthMode === 'invite';
  const wasSignedIn = Boolean(req.session.userId);
  const fallback = isInviteMode ? '/login' : (wasSignedIn ? '/settings' : '/login');

  if (error) {
    req.flash('error', `LinkedIn denied access: ${errorDescription || error}`);
    return res.redirect(fallback);
  }
  if (!state || state !== req.session.oauthState) {
    req.flash('error', 'OAuth state mismatch — please try connecting again.');
    return res.redirect(fallback);
  }
  req.session.oauthState = null;
  req.session.oauthMode = null;

  try {
    const { user, isNewUser } = await linkedinAuth.completeLogin(code);

    if (isInviteMode) {
      // Invite flow: store token & profile in DB, but do NOT set app session userId.
      // Show client a friendly success screen confirming they are connected.
      return res.render('invite-success', {
        layout: false,
        userName: user.displayName || 'there',
      });
    }

    // Normal admin sign-in flow: regenerate session & set userId
    await new Promise((resolve, reject) =>
      req.session.regenerate((err) => (err ? reject(err) : resolve()))
    );
    req.session.userId = user.id;

    req.flash('success', isNewUser ? `Welcome, ${user.displayName || 'there'} — you're all set.` : 'LinkedIn account connected.');
    res.redirect('/');
  } catch (err) {
    logger.error('OAuth callback failed:', err.response?.data || err.message);
    req.flash('error', `Failed to complete LinkedIn login: ${err.response?.data?.error_description || err.message}`);
    res.redirect(fallback);
  }
});

// Settings' "Disconnect" button
router.post('/disconnect-linkedin', async (req, res) => {
  const effectiveUserId = req.session.activeUserId || req.session.userId;
  await storage.clearToken(effectiveUserId);
  req.flash('success', 'Disconnected from LinkedIn.');
  res.redirect('/settings');
});

// Real app sign-out
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// Refresh organization pages for effective user
router.post('/refresh-organizations', async (req, res) => {
  try {
    const effectiveUserId = req.session.activeUserId || req.session.userId;
    const orgs = await linkedinAuth.refreshOrganizations(effectiveUserId);
    req.flash(
      'success',
      orgs.length > 0
        ? `Found ${orgs.length} company page(s) administered.`
        : 'No company pages found for this connection.'
    );
  } catch (err) {
    logger.error('Refresh organizations failed:', err.response?.data || err.message);
    req.flash('error', `Could not refresh company pages: ${err.response?.data?.message || err.message}`);
  }
  res.redirect('/settings');
});

module.exports = router;

