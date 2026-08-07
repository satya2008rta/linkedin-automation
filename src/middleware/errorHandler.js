const logger = require('../utils/logger');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  logger.error(err.stack || err.message || err);
  const status = err.status || 500;
  const message = err.userMessage || err.message || 'Something went wrong.';

  if (req.path.startsWith('/posts/') || req.headers.accept?.includes('application/json') || req.xhr) {
    return res.status(status).json({ error: message });
  }

  if (req.flash) req.flash('error', message);
  if (req.accepts('html')) {
    return res.redirect(req.get('Referrer') || '/');
  }
  res.status(status).json({ error: message });
}

module.exports = errorHandler;
