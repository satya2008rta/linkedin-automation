// Gates every page view behind having signed in via LinkedIn (see auth.routes.js's OAuth
// callback, the only place req.session.userId ever gets set). Mounted in server.js AFTER
// /health, /login, and /auth/* — those three must stay reachable by a signed-out visitor,
// everything else sits behind this.
function requireLogin(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

// JSON variant for the two fetch()-based endpoints (media upload, AI rewrite) where a
// redirect-to-HTML response would silently break the caller instead of surfacing a clear
// error the client-side code can actually show the user.
function requireLoginJson(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not signed in.' });
  next();
}

module.exports = { requireLogin, requireLoginJson };
