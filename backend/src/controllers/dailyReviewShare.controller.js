const DailyReviewShare = require('../models/DailyReviewShare');
const AccountBalanceService = require('../services/accountBalanceService');
const { getUserTimezone, getDateInTimezone } = require('../utils/timezone');

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

      // Only ever refresh the strip for TODAY. Capturing live balances for a past
      // date stamped current Net Liq / cash onto that day and, worse,
      // captureAccountSnapshotForDay persists into equity_snapshots at the old
      // date and overwrites user_settings.account_equity -- so merely opening a
      // three-week-old share link rewrote the historical equity series that the
      // K-Ratio calculation reads. A stale strip on an old share is correct:
      // it is a snapshot of that day, not a live view.
      // "Today" must be the USER's today, not UTC's -- a UTC comparison flips
      // hours early/late for anyone outside UTC, so a share could refresh on the
      // wrong calendar day (or fail to refresh on the right one).
      const userId = user.id || dailyShare.user_id;
      const timezone = await getUserTimezone(userId);
      const today = getDateInTimezone(new Date(), timezone);

      if (dailyShareDate === today) {
        try {
          const live = await AccountBalanceService.captureAccountSnapshotForDay(userId, dailyShareDate);
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
