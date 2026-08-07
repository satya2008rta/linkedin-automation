const express = require('express');
const router = express.Router();
const storage = require('../services/storage.service');
const { env } = require('../config/env');

router.get('/', async (req, res, next) => {
  try {
    const [pending, posted, failed, drafts, engagements] = await Promise.all([
      storage.listPosts({ status: 'pending' }),
      storage.listPosts({ status: 'posted' }),
      storage.listPosts({ status: 'failed' }),
      storage.listPosts({ status: 'draft' }),
      storage.listEngagements(),
    ]);
    res.render('dashboard', {
      title: 'Dashboard',
      active: 'dashboard',
      pending,
      posted: posted.slice(-5).reverse(),
      failed,
      drafts,
      engagements: engagements.slice(0, 5),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/compose', async (req, res, next) => {
  try {
    const token = await storage.getToken();
    res.render('compose', { title: 'Compose', active: 'compose', token, post: null });
  } catch (err) {
    next(err);
  }
});

router.get('/queue', async (req, res, next) => {
  try {
    const posts = await storage.listPosts({});
    const queued = posts.filter((p) => p.status !== 'draft' && p.status !== 'posted');
    const token = await storage.getToken();
    res.render('queue', { title: 'Queue', active: 'queue', posts: queued, token });
  } catch (err) {
    next(err);
  }
});

router.get('/posted', async (req, res, next) => {
  try {
    const posts = await storage.listPosts({ status: 'posted' });
    posts.sort((a, b) => new Date(b.postedAt || b.createdAt) - new Date(a.postedAt || a.createdAt));
    const token = await storage.getToken();
    res.render('posted', { title: 'Posted', active: 'posted', posts, token });
  } catch (err) {
    next(err);
  }
});

router.get('/engage', async (req, res, next) => {
  try {
    const engagements = await storage.listEngagements();
    res.render('engage', { title: 'Engage', active: 'engage', engagements });
  } catch (err) {
    next(err);
  }
});

router.get('/calendar', async (req, res, next) => {
  try {
    const allPosts = await storage.listPosts({});
    const settings = await storage.getSettings();
    const token = await storage.getToken();

    const now = new Date();
    const reqYear = parseInt(req.query.year, 10) || now.getFullYear();
    const reqMonth = parseInt(req.query.month, 10) || (now.getMonth() + 1);

    const drafts = allPosts.filter((p) => p.status === 'draft');
    const byDate = {};
    for (const d of drafts) {
      const key = (d.scheduledFor || d.createdAt).slice(0, 10);
      (byDate[key] = byDate[key] || []).push(d);
    }
    const days = Object.keys(byDate).sort();

    res.render('calendar', {
      title: 'AI Calendar',
      active: 'calendar',
      allPosts,
      byDate,
      days,
      settings,
      token,
      year: reqYear,
      month: reqMonth,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/settings', async (req, res, next) => {
  try {
    const token = await storage.getToken();
    const settings = await storage.getSettings();
    res.render('settings', { title: 'Settings', active: 'settings', token, settings, redirectUri: env.linkedin.redirectUri });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
