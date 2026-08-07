const cron = require('node-cron');
const { runDueJobs } = require('./postRunner');
const logger = require('../utils/logger');

// Cheap extra safety on top of the transactional claim in storage.service: skip a tick
// entirely if the previous one is somehow still running (e.g. a slow LinkedIn API call).
let isRunning = false;

function startScheduler() {
  cron.schedule('* * * * *', async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      const count = await runDueJobs();
      if (count > 0) logger.info(`Scheduler processed ${count} due post(s).`);
    } catch (err) {
      logger.error('Scheduler tick failed:', err.message);
    } finally {
      isRunning = false;
    }
  });
  logger.info('Scheduler started (checks for due posts every minute).');
}

module.exports = { startScheduler };
