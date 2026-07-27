// Mirror of DATA_START_DATE in backend/src/utils/dataStartDate.js.
//
// This instance stores no trade history before this date: everything older was
// purged by migration 239, and the backend rejects any attempt to add more
// (CSV import, broker sync, API, backup restore, and a CHECK constraint on
// trades.trade_date). The frontend uses it to floor date pickers and to tell
// users why older data will not appear.
//
// Keep the two constants in sync — the backend is authoritative.
export const DATA_START_DATE = '2026-07-25'

// Rendered form for UI copy. Built from the constant rather than hardcoded
// twice so the two can't disagree. Parsed as UTC so the day doesn't shift for
// users west of UTC.
export const DATA_START_DATE_LABEL = new Date(`${DATA_START_DATE}T00:00:00Z`)
  .toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
  })

/** True when an ISO date/timestamp string falls before the data start date. */
export function isBeforeDataStart(value) {
  if (!value) return false
  return String(value).slice(0, 10) < DATA_START_DATE
}

/** Raise a date to the data start date; null/empty means "all time" → the floor. */
export function clampToDataStart(value) {
  const dateOnly = value ? String(value).slice(0, 10) : ''
  return !dateOnly || dateOnly < DATA_START_DATE ? DATA_START_DATE : dateOnly
}

export default { DATA_START_DATE, DATA_START_DATE_LABEL, isBeforeDataStart, clampToDataStart }
