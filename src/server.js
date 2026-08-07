const path = require('path');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const expressLayouts = require('express-ejs-layouts');

const { env } = require('./config/env');
require('./config/db'); // applies schema on first boot
const storage = require('./services/storage.service');
const logger = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');
const routes = require('./routes');
const { startScheduler } = require('./scheduler/cron');
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

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    secret: env.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 4 }, // 4h — only used to hold the OAuth CSRF nonce
  })
);
app.use(flash());

// Every view needs the token-connection badge and any flash messages, so compute them
// once here rather than repeating it in every route handler.
app.use(async (req, res, next) => {
  try {
    res.locals.tokenStatus = await storage.tokenStatus();
    res.locals.messages = { error: req.flash('error'), success: req.flash('success') };
    res.locals.active = '';
    next();
  } catch (err) {
    next(err);
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/', routes);

app.use((req, res) => {
  res.status(404).render('404', { title: 'Not found', active: '' });
});

app.use(errorHandler);

app.listen(env.port, () => {
  logger.info(`LinkedIn Automation dashboard running at http://localhost:${env.port}`);
  startScheduler();
});
