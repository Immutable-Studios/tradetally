const express = require('express');
const router = express.Router();
const dailyReviewShareController = require('../controllers/dailyReviewShare.controller');
const analyticsController = require('../controllers/analytics.controller');
const tradeController = require('../controllers/trade.controller');
const {
  resolveDailyShareToken,
  forceShareDay,
  forceShareDateRange
} = require('../middleware/dailyShareAuth');

/**
 * Public, unauthenticated routes backing the Daily Review email's "magic
 * link". A valid token resolves to its owner's real user record (see
 * resolveDailyShareToken), then delegates straight into the same
 * authenticated analytics/trade controllers the logged-in /daily page uses -
 * every query below is still scoped to that one user's data. The day/trades
 * routes force the date range to the share's single day so a token only ever
 * exposes that one day, not the user's full history; the positions route
 * intentionally shows the live open book (not date-scoped), matching what
 * the authenticated Daily Review page shows as "open positions context".
 */

router.get('/:token', resolveDailyShareToken, dailyReviewShareController.getShareMeta);

router.get('/:token/day', resolveDailyShareToken, forceShareDay, analyticsController.getCalendarDayDetail);

router.get('/:token/trades', resolveDailyShareToken, forceShareDateRange, tradeController.getUserTrades);

router.get('/:token/positions', resolveDailyShareToken, tradeController.getOpenPositionsWithQuotes);

// Chart data for a trade owned by the share's user. Reuses getTradeChartData
// (ownership-scoped via req.user.id) so shared Daily Review pages can show
// the same inline charts as the authenticated view without a login cookie.
router.get(
  '/:token/trades/:id/chart-data',
  resolveDailyShareToken,
  tradeController.getTradeChartData
);

module.exports = router;
