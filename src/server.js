const path = require('path');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const expressLayouts = require('express-ejs-layouts');

const { env } = require('./config/env');
require('./config/db'); // applies schema on first boot
const storage = require('./services/storage.service');
const SqliteSessionStore = require('./services/sqliteSessionStore');
const { requireLogin, requireLoginJson } = require('./middleware/requireLogin');
const logger = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');
const authRoutes = require('./routes/auth.routes');
const routes = require('./routes');
const { startScheduler } = require('./scheduler/cron');
const { startAutoUpdateChecker } = require('./scheduler/autoUpdate');
const time = require('./utils/time');

const app = express();

// Small helpers made available to every EJS view without threading them through each
// route handler — views can't `require()` on their own (they're compiled into plain
// functions, not Node modules), so anything they need has to be exposed this way.
app.locals.friendlyDate = time.friendly;
app.locals.isoToLocalInput = time.isoToLocalInput;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    store: new SqliteSessionStore(), // persists across restarts — see sqliteSessionStore.js
    secret: env.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true, // extend expiry on activity, so an active user is never logged out mid-use
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days — a session now represents a signed-in person, not just an OAuth nonce
      httpOnly: true,
      sameSite: 'lax',
      secure: env.cookieSecure, // see env.js — off for local http, flip on once behind real HTTPS
    },
  })
);
app.use(flash());

app.get('/health', (req, res) => res.json({ ok: true }));

// Reachable while signed out — this is what makes "connect LinkedIn" double as app login.
// Mounted ahead of requireLogin below so the OAuth dance never gets redirected to /login
// mid-flow.
app.use('/auth', authRoutes);

app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.render('login', {
    layout: false,
    messages: { error: req.flash('error'), success: req.flash('success') },
  });
});

// These two endpoints are called via fetch() from already-loaded pages (image upload, AI
// rewrite) — an HTML redirect response would just silently break the caller instead of
// surfacing something the client-side code can show the user, so they get the JSON-401
// variant ahead of the general HTML gate below (harmless no-op for an authenticated caller,
// who just falls through to it same as any other route).
app.use('/posts/upload-media', requireLoginJson);
app.use('/ai/rewrite-text', requireLoginJson);

app.use(requireLogin);

// Every view needs the current account, its token-connection badge, and any flash
// messages, so compute them once here rather than repeating it in every route handler.
// Runs after requireLogin, so req.session.userId is guaranteed set here — except for the
// edge case where the user row itself was deleted out from under an existing session,
// which the fallback below handles by signing them out cleanly instead of crashing a render.
app.use(async (req, res, next) => {
  try {
    const sessionUser = await storage.getUserById(req.session.userId);
    if (!sessionUser) {
      return req.session.destroy(() => res.redirect('/login'));
    }

    const isAdmin = (sessionUser.email || '').toLowerCase() === env.adminEmail;
    let activeUserId = req.session.userId;

    if (isAdmin && req.session.activeUserId) {
      const activeUser = await storage.getUserById(req.session.activeUserId);
      if (activeUser) {
        activeUserId = activeUser.id;
      } else {
        delete req.session.activeUserId;
      }
    }

    req.activeUserId = activeUserId;
    const currentUser = (activeUserId === req.session.userId)
      ? sessionUser
      : await storage.getUserById(activeUserId);

    res.locals.adminUser = sessionUser;
    res.locals.currentUser = currentUser;
    res.locals.isAdmin = isAdmin;
    res.locals.activeUserId = activeUserId;
    res.locals.allUsers = isAdmin ? await storage.listAllUsers() : [];
    res.locals.tokenStatus = await storage.tokenStatus(activeUserId);
    res.locals.messages = { error: req.flash('error'), success: req.flash('success') };
    res.locals.active = '';
    next();
  } catch (err) {
    next(err);
  }
});

app.use('/', routes);

app.use((req, res) => {
  res.status(404).render('404', { title: 'Not found', active: '' });
});

app.use(errorHandler);

app.listen(env.port, () => {
  logger.info(`LinkedIn Automation dashboard running at http://localhost:${env.port}`);
  startScheduler();
  if (env.autoUpdate.enabled) startAutoUpdateChecker();
});
