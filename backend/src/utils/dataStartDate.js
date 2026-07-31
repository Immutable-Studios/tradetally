// Global data start date — the hard floor for every trade this instance stores.
//
// Trades dated before DATA_START_DATE were purged (migration 239, then raised
// again by migration 242) and can no longer be created: CSV import, broker
// sync, the API, backup restore and the v2/v3 settings importer all filter
// against this constant, and the trades_trade_date_on_or_after_start CHECK
// constraint backstops any path that forgets to. Everything that displays the
// floor to a user reads it from here (the frontend has a mirror in
// frontend/src/config/dataStart.js — keep the two in sync).
//
// This is deliberately hardcoded rather than configurable: it is a property of
// this deployment's data, not a user preference. Changing it does NOT resurrect
// purged history, and lowering it requires dropping the CHECK constraint first.

const DATA_START_DATE = '2026-07-31';

// Human-readable form for API error messages. The frontend formats its own.
const DATA_START_DATE_LABEL = 'July 31, 2026';

/**
 * Normalize anything date-ish to a 'YYYY-MM-DD' string, or null when it can't
 * be read as a date. Date objects are read in UTC, matching how the rest of the
 * codebase collapses timestamps to DATE columns (see Trade.create).
 */
function toDateOnly(value) {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }

  if (typeof value === 'string') {
    // Already 'YYYY-MM-DD' or an ISO timestamp — take the date portion as-is so
    // we don't shift the day by re-parsing through the server's local timezone.
    const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) return match[1];
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

/**
 * True when the given date falls before the data start date. Unreadable or
 * missing dates return false — callers that require a date validate that
 * separately, and we don't want an unparseable value to silently drop a trade.
 */
function isBeforeDataStart(value) {
  const dateOnly = toDateOnly(value);
  if (!dateOnly) return false;
  return dateOnly < DATA_START_DATE;
}

/**
 * Raise a requested sync/query start date to the data start date. Passing null
 * (meaning "all time") returns the floor, so no broker is ever asked for
 * history we would immediately throw away.
 */
function clampToDataStart(startDate) {
  const dateOnly = toDateOnly(startDate);
  if (!dateOnly || dateOnly < DATA_START_DATE) return DATA_START_DATE;
  return dateOnly;
}

// Carries an exact HTTP response the way AppError does (isAppError + statusCode
// + body), so a rejected trade surfaces as a 400 explaining the cutoff rather
// than a generic 500 from the error handler's fallthrough.
class DataStartDateError extends Error {
  constructor(tradeDate) {
    const rejected = toDateOnly(tradeDate) || tradeDate;
    const message =
      `Trade date ${rejected} is before this instance's data start date ` +
      `(${DATA_START_DATE}). Only trades on or after ${DATA_START_DATE_LABEL} are recorded.`;
    super(message);
    this.name = 'DataStartDateError';
    this.code = 'BEFORE_DATA_START_DATE';
    this.isAppError = true;
    this.statusCode = 400;
    this.tradeDate = toDateOnly(tradeDate);
    this.dataStartDate = DATA_START_DATE;
    this.body = {
      error: 'Bad Request',
      code: 'BEFORE_DATA_START_DATE',
      message,
      dataStartDate: DATA_START_DATE
    };
  }
}

/** Throw DataStartDateError when the date precedes the floor. No-op otherwise. */
function assertOnOrAfterDataStart(value) {
  if (isBeforeDataStart(value)) throw new DataStartDateError(value);
}

module.exports = {
  DATA_START_DATE,
  DATA_START_DATE_LABEL,
  toDateOnly,
  isBeforeDataStart,
  clampToDataStart,
  assertOnOrAfterDataStart,
  DataStartDateError
};
