const storage = require('../services/storage.service');

// Blocks actions that would call the LinkedIn API (posting, scheduling, engaging, AI
// approval into the queue) when there's no connected account or the token has expired.
// Read-only page views are not gated by this — users should still be able to see the
// dashboard/settings and reconnect.
async function requireValidToken(req, res, next) {
  const status = await storage.tokenStatus();
  if (!status.connected || status.expired) {
    req.flash('error', 'Your LinkedIn connection is missing or expired. Reconnect in Settings before doing that.');
    return res.redirect('/settings');
  }
  req.tokenStatus = status;
  next();
}

module.exports = requireValidToken;
