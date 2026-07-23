const DailyReviewShare = require('../models/DailyReviewShare');
const AccountBalanceService = require('../services/accountBalanceService');

module.exports = {
  /**
   * Lightweight metadata for the shared day - lets the frontend render a
   * header ("Daily review for Jul 18, 2026") before/alongside the heavier
   * day/trades/positions calls. Also records the view for basic visibility
   * into whether the link has been opened.
   *
   * Includes a frozen (or freshly captured) Schwab account strip for Net Liq
   * and the equity denominator used by per-trade "% of equity" metrics.
   */
  async getShareMeta(req, res, next) {
    try {
      const { dailyShare, dailyShareDate, user } = req;

      DailyReviewShare.recordView(dailyShare.id).catch((error) => {
        console.error('[DAILY-REVIEW-SHARE] Failed to record view:', error.message);
      });

      let accountStrip = dailyShare.account_snapshot || null;

      // Backfill if this share was created before account snapshots / open heat,
      // or refresh when viewing "today" so the strip stays current.
      const today = new Date().toISOString().slice(0, 10);
      const shouldRefresh = !accountStrip
        || dailyShareDate === today
        || accountStrip.openHeat == null;
      if (shouldRefresh) {
        try {
          const live = await AccountBalanceService.captureAccountSnapshotForDay(
            user.id || dailyShare.user_id,
            dailyShareDate
          );
          if (live) {
            accountStrip = live;
            await DailyReviewShare.updateAccountSnapshot(dailyShare.id, live);
          }
        } catch (error) {
          console.warn('[DAILY-REVIEW-SHARE] Live account strip failed:', error.message);
        }
      }

      res.json({
        date: dailyShareDate,
        username: user.username || user.full_name || null,
        expiresAt: dailyShare.expires_at,
        createdAt: dailyShare.created_at,
        accountStrip,
        equityForPct: accountStrip?.equityForPct ?? accountStrip?.sodNetLiq ?? accountStrip?.netLiq ?? null
      });
    } catch (error) {
      next(error);
    }
  }
};
