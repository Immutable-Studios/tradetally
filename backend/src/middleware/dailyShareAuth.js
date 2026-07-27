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
    // Null on legacy shares minted before reviews were split per account —
    // those stay all-accounts rather than silently changing what an already
    // emailed link shows.
    req.dailyShareAccount = share.account_identifier || null;
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
 * The account filter every share-scoped query must carry. A share belongs to
 * one account, so its page must never surface another account's trades — the
 * whole point of splitting reviews per account. Legacy (null-account) shares
 * get no filter and stay all-accounts.
 */
function shareAccountFilter(req) {
  return req.dailyShareAccount ? { accounts: req.dailyShareAccount } : {};
}

/**
 * Locks req.query.date to the share's day, ignoring anything the caller
 * passed, before delegating to analyticsController.getCalendarDayDetail.
 */
function forceShareDay(req, res, next) {
  setQuery(req, { date: req.dailyShareDate, ...shareAccountFilter(req) });
  next();
}

/**
 * Locks the open-positions view to the share's account. Not date-scoped: the
 * page intentionally shows the live open book as context.
 */
function forceShareAccount(req, res, next) {
  setQuery(req, shareAccountFilter(req));
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
    limit: req.query?.limit || '200',
    ...shareAccountFilter(req)
  });
  next();
}

module.exports = {
  resolveDailyShareToken,
  forceShareDay,
  forceShareDateRange,
  forceShareAccount
};
