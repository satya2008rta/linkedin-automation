const express = require('express');
const router = express.Router();

// Note: /auth/* is mounted directly in server.js, ahead of the requireLogin gate — it has
// to stay reachable while signed out (that's the whole point of it). Everything mounted
// here in index.js sits behind that gate.
router.use('/', require('./dashboard.routes'));
router.use('/posts', require('./posts.routes'));
router.use('/engagement', require('./engagement.routes'));
router.use('/ai', require('./ai.routes'));

module.exports = router;
