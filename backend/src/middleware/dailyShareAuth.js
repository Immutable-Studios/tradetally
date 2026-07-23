const DailyReviewShare = require('../models/DailyReviewShare');
const User = require('../models/User');

/**
 * Resolves a Daily Review share token into a full req.user (matching the
 * shape `authenticate` sets) plus req.dailyShare, so the existing
 * authenticated analytics/trade controllers can be reused unmodified for the
 * public share routes. The token only ever maps to its owner's own data -
 * every downstream query is still scoped by req.user.id like normal.
 */
async function resolveDailyShareToken(req, res, next) {
  try {
    const { token } = req.params;
    const share = await DailyReviewShare.findByToken(token);

    if (!share || DailyReviewShare.isExpired(share)) {
      return res.status(404).json({ error: 'This share link is invalid or has expired' });
    }

    const user = await User.findById(share.user_id);
    if (!user || !user.is_active) {
      return res.status(404).json({ error: 'This share link is invalid or has expired' });
    }

    req.user = user;
    req.dailyShare = share;
    // share_date comes back from pg as a Date at UTC midnight - normalize to
    // a plain YYYY-MM-DD string for query params.
    req.dailyShareDate = share.share_date instanceof Date
      ? share.share_date.toISOString().slice(0, 10)
      : String(share.share_date).slice(0, 10);

    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Express 5 exposes req.query as a getter; assigning properties is a no-op.
 * Replace the descriptor so share-scoped query locks actually stick.
 */
function setQuery(req, patch) {
  Object.defineProperty(req, 'query', {
    value: { ...(req.query || {}), ...patch },
    writable: true,
    configurable: true,
    enumerable: true
  });
}

/**
 * Locks req.query.date to the share's day, ignoring anything the caller
 * passed, before delegating to analyticsController.getCalendarDayDetail.
 */
function forceShareDay(req, res, next) {
  setQuery(req, { date: req.dailyShareDate });
  next();
}

/**
 * Locks req.query start/end date range to the share's single day before
 * delegating to tradeController.getUserTrades - a share token grants access
 * to that one day, not the user's full trade history.
 */
function forceShareDateRange(req, res, next) {
  setQuery(req, {
    startDate: req.dailyShareDate,
    endDate: req.dailyShareDate,
    limit: req.query?.limit || '200'
  });
  next();
}

module.exports = {
  resolveDailyShareToken,
  forceShareDay,
  forceShareDateRange
};
