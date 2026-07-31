// External trigger for the Daily Review email batch.
//
// The in-process scheduler (services/schedulers/dailyReviewEmailScheduler) only
// fires while the container is running. This deployment has Railway app
// sleeping enabled, so an idle instance is stopped well before the 13:15 PT
// cron time and the batch silently never runs. An inbound request both wakes
// the app and runs the batch, which is why this endpoint exists.
//
// Mounted under /api/internal (see routes/internal.routes.js) and therefore
// behind requireInternalServiceAuth — a shared secret, not a user session.

const DailyReviewShareService = require('../services/dailyReviewShareService');

// Module-level rather than per-request: the batch syncs brokers and sends mail,
// so two overlapping runs would double-sync and could double-send. A scheduler
// retry landing on top of a slow run is the realistic case.
let inFlight = null;

const dailyReviewCronController = {
  /**
   * POST /api/internal/cron/daily-review
   *
   * Body (all optional):
   *   background     - respond 202 immediately instead of waiting for the batch.
   *                    Only safe where something else keeps the app awake; by
   *                    default the request is held open, which is what stops
   *                    Railway from sleeping the container mid-run.
   *   skipIfSentToday - defaults true; false forces a re-send.
   */
  async runDailyBatch(req, res, next) {
    const background = req.body?.background === true;
    const skipIfSentToday = req.body?.skipIfSentToday !== false;

    if (inFlight) {
      return res.status(409).json({
        error: 'A daily review batch is already running',
        code: 'DAILY_REVIEW_BATCH_IN_PROGRESS'
      });
    }

    const startedAt = Date.now();
    const run = DailyReviewShareService.runDailyBatch({ skipIfSentToday })
      .finally(() => { inFlight = null; });
    inFlight = run;

    if (background) {
      // Nothing awaits this, so an unhandled rejection would take the process
      // down. Log and swallow — the caller already has its 202.
      run.catch((error) => {
        console.error('[DAILY-REVIEW-CRON] Background batch failed:', error.message);
      });
      return res.status(202).json({
        status: 'started',
        background: true,
        skipIfSentToday
      });
    }

    try {
      const stats = await run;
      return res.json({
        status: 'completed',
        durationMs: Date.now() - startedAt,
        skipIfSentToday,
        ...stats
      });
    } catch (error) {
      return next(error);
    }
  },

  /** GET /api/internal/cron/daily-review/status — is a run in progress? */
  async getStatus(req, res) {
    return res.json({
      running: inFlight !== null,
      cron: process.env.DAILY_REVIEW_EMAIL_CRON || '15 13 * * *',
      timezone: process.env.DAILY_REVIEW_EMAIL_TZ || process.env.TZ || 'America/Los_Angeles',
      schedulerEnabled: process.env.ENABLE_DAILY_REVIEW_EMAIL === 'true'
    });
  }
};

module.exports = dailyReviewCronController;
