const CronScheduler = require('./CronScheduler');

/**
 * Daily Review Email Scheduler
 * Runs the daily batch that syncs broker connections, then emails each
 * opted-in user a no-login share link to today's Daily Review.
 * Default: 1:15pm America/Los_Angeles (after US equity cash close).
 * Override with DAILY_REVIEW_EMAIL_CRON / DAILY_REVIEW_EMAIL_TZ.
 */
class DailyReviewEmailScheduler extends CronScheduler {
  constructor() {
    super({
      logPrefix: '[DAILY-REVIEW-EMAIL]',
      cronEnvVar: 'DAILY_REVIEW_EMAIL_CRON',
      defaultCron: '15 13 * * *',
      guardRestart: true,
      returnBoolean: true,
      getScheduleOptions: () => ({
        scheduled: true,
        timezone: process.env.DAILY_REVIEW_EMAIL_TZ || process.env.TZ || 'America/Los_Angeles'
      }),
      skipReturnValue: null,
      errorReturnValue: null,
      errorLogsMessageOnly: true,
      messages: {
        alreadyStarted: '[DAILY-REVIEW-EMAIL] Scheduler already running',
        started: (cronExpression) => `[DAILY-REVIEW-EMAIL] Scheduler started (cron: ${cronExpression})`,
        stopped: '[DAILY-REVIEW-EMAIL] Scheduler stopped',
        skip: '[DAILY-REVIEW-EMAIL] Batch already in progress, skipping this run',
        runError: '[DAILY-REVIEW-EMAIL] Daily batch failed:'
      }
    });
  }

  getStatus() {
    return {
      schedulerRunning: Boolean(this.job),
      batchInProgress: this.running,
      cronExpression: process.env.DAILY_REVIEW_EMAIL_CRON || '15 13 * * *',
      timezone: process.env.DAILY_REVIEW_EMAIL_TZ || process.env.TZ || 'America/Los_Angeles'
    };
  }

  onTick() {
    return this.runBatch();
  }

  async runBatch() {
    return this.runExclusive();
  }

  async execute() {
    const DailyReviewShareService = require('../dailyReviewShareService');
    return await DailyReviewShareService.runDailyBatch();
  }
}

module.exports = new DailyReviewEmailScheduler();
