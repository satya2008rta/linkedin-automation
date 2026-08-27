const express = require('express');
const router = express.Router();
const storage = require('../services/storage.service');
const { env } = require('../config/env');

router.get('/', async (req, res, next) => {
  try {
    const userId = req.activeUserId;
    const [pending, posted, failed, drafts, engagements] = await Promise.all([
      storage.listPosts(userId, { status: 'pending' }),
      storage.listPosts(userId, { status: 'posted' }),
      storage.listPosts(userId, { status: 'failed' }),
      storage.listPosts(userId, { status: 'draft' }),
      storage.listEngagements(userId),
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
    const userId = req.activeUserId;
    const token = await storage.getToken(userId);
    const organizations = await storage.listOrganizations(userId);
    const settings = await storage.getSettings(userId);
    res.render('compose', { title: 'Compose', active: 'compose', token, post: null, organizations, settings });
  } catch (err) {
    next(err);
  }
});

router.get('/queue', async (req, res, next) => {
  try {
    const userId = req.activeUserId;
    const posts = await storage.listPosts(userId, {});
    const queued = posts.filter((p) => p.status !== 'draft' && p.status !== 'posted');
    const token = await storage.getToken(userId);
    const organizations = await storage.listOrganizations(userId);
    const settings = await storage.getSettings(userId);
    res.render('queue', { title: 'Queue', active: 'queue', posts: queued, token, organizations, settings });
  } catch (err) {
    next(err);
  }
});

router.get('/posted', async (req, res, next) => {
  try {
    const userId = req.activeUserId;
    const posts = await storage.listPosts(userId, { status: 'posted' });
    posts.sort((a, b) => new Date(b.postedAt || b.createdAt) - new Date(a.postedAt || a.createdAt));
    const token = await storage.getToken(userId);
    res.render('posted', { title: 'Posted', active: 'posted', posts, token });
  } catch (err) {
    next(err);
  }
});

router.get('/engage', async (req, res, next) => {
  try {
    const engagements = await storage.listEngagements(req.activeUserId);
    res.render('engage', { title: 'Engage', active: 'engage', engagements });
  } catch (err) {
    next(err);
  }
});

router.get('/calendar', async (req, res, next) => {
  try {
    const userId = req.activeUserId;
    const allPosts = await storage.listPosts(userId, {});
    const settings = await storage.getSettings(userId);
    const token = await storage.getToken(userId);
    const organizations = await storage.listOrganizations(userId);

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
      organizations,
      year: reqYear,
      month: reqMonth,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/settings', async (req, res, next) => {
  try {
    const userId = req.activeUserId;
    const token = await storage.getToken(userId);
    const settings = await storage.getSettings(userId);
    const organizations = await storage.listOrganizations(userId);
    res.render('settings', {
      title: 'Settings',
      active: 'settings',
      token,
      settings,
      organizations,
      redirectUri: env.linkedin.redirectUri,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
