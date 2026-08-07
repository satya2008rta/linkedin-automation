const express = require('express');
const router = express.Router();

router.use('/', require('./dashboard.routes'));
router.use('/auth', require('./auth.routes'));
router.use('/posts', require('./posts.routes'));
router.use('/engagement', require('./engagement.routes'));
router.use('/ai', require('./ai.routes'));

module.exports = router;
