const storage = require('../services/storage.service');

// Blocks actions that would call the LinkedIn API (posting, scheduling, engaging, AI
// approval into the queue) when the CURRENT SIGNED-IN USER has no connected account or
// their token has expired. Read-only page views are not gated by this — users should
// still be able to see the dashboard/settings and reconnect. Assumes requireLogin has
// already run (req.session.userId is set) — mounted after it in server.js.
async function requireValidToken(req, res, next) {
  const status = await storage.tokenStatus(req.session.userId);
  if (!status.connected || status.expired) {
    req.flash('error', 'Your LinkedIn connection is missing or expired. Reconnect in Settings before doing that.');
    return res.redirect('/settings');
  }
  req.tokenStatus = status;
  next();
}

module.exports = requireValidToken;
