const { execFile, spawn } = require('child_process');
const path = require('path');
const { env } = require('../config/env');
const storage = require('../services/storage.service');
const logger = require('../utils/logger');

const REPO_ROOT = path.join(__dirname, '..', '..');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: REPO_ROOT, timeout: 60000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.trim() || err.message));
      resolve(stdout.trim());
    });
  });
}

// Re-launches via the batch file (which already knows how to find/kill whatever's holding
// the port and start fresh — see "Start LinkedIn Automation.bat") as a detached process,
// then exits this one. Reusing that script instead of re-implementing its startup logic
// here means both paths (double-click and auto-update) always behave identically.
function restartApp() {
  const batPath = path.join(REPO_ROOT, 'Start LinkedIn Automation.bat');
  const child = spawn('cmd.exe', ['/c', 'start', '""', `"${batPath}"`], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  logger.info('Auto-update: new instance launching, exiting this one now.');
  setTimeout(() => process.exit(0), 1500);
}

async function checkForUpdates() {
  try {
    await run('git', ['fetch', 'origin', 'main']);
    const local = await run('git', ['rev-parse', 'HEAD']);
    const remote = await run('git', ['rev-parse', 'origin/main']);
    if (local === remote) return; // already up to date, nothing to do

    logger.info(`Auto-update: new commit(s) found on origin/main (${local.slice(0, 7)} → ${remote.slice(0, 7)}).`);

    // Never overwrite uncommitted local edits to tracked files. .env and data/*.db are
    // gitignored so they're never "dirty" here — this only guards actual source changes.
    const dirty = await run('git', ['status', '--porcelain']);
    if (dirty) {
      logger.warn('Auto-update: local uncommitted changes present — skipping this cycle rather than risk overwriting them.');
      return;
    }

    // Don't restart mid-publish — that's exactly the scenario that left a post in an
    // ambiguous state once already (see reapStaleLocks in storage.service.js). Defer to
    // the next check instead of forcing it.
    const inFlight = await storage.anyPostsWithStatus('posting');
    if (inFlight) {
      logger.warn('Auto-update: a post is currently being published — deferring restart to the next check.');
      return;
    }

    const changedFiles = await run('git', ['diff', '--name-only', `${local}..${remote}`]);
    const depsChanged = /(^|\n)package(-lock)?\.json$/.test(changedFiles);

    await run('git', ['pull', '--ff-only', 'origin', 'main']);
    logger.info('Auto-update: pulled latest changes.');

    if (depsChanged) {
      logger.info('Auto-update: package.json changed — running npm install...');
      await run('npm', ['install']);
    }

    logger.info('Auto-update: restarting to apply the update...');
    restartApp();
  } catch (err) {
    logger.error('Auto-update check failed:', err.message);
  }
}

function startAutoUpdateChecker() {
  const intervalMs = env.autoUpdate.intervalMinutes * 60000;
  logger.info(`Auto-update checker started (checking origin/main every ${env.autoUpdate.intervalMinutes} min).`);
  setInterval(() => {
    checkForUpdates().catch((err) => logger.error('Auto-update check crashed:', err.message));
  }, intervalMs);
}

module.exports = { startAutoUpdateChecker, checkForUpdates };
