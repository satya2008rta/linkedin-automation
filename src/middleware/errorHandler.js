const logger = require('../utils/logger');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  logger.error(err.stack || err.message || err);
  const status = err.status || 500;
  if (req.flash) req.flash('error', err.userMessage || err.message || 'Something went wrong.');
  if (req.accepts('html')) {
    return res.redirect(req.get('Referrer') || '/');
  }
  res.status(status).json({ error: err.userMessage || err.message || 'Something went wrong.' });
}

module.exports = errorHandler;
