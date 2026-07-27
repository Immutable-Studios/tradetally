// Parsing for the deterministic daily-review URL, e.g. /daily/7272026.
//
// The canonical form is 8-digit MMDDYYYY (07272026). Shorter and ISO forms are
// accepted too so a hand-typed or bookmarked link works:
//
//   07272026     MMDDYYYY  (canonical)
//   7272026      MDDYYYY   — the form you get by dropping the leading zero
//   072726       MMDDYY
//   20260727     YYYYMMDD  — tried when MMDDYYYY yields an impossible month
//   2026-07-27   ISO
//
// Returns 'YYYY-MM-DD', or null when the value cannot be read as a real date.

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function isRealDate(year, month, day) {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return false
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  // Round-trip through Date to reject 2026-02-30 and friends. UTC so the
  // result never shifts for users west of the line.
  const d = new Date(Date.UTC(year, month - 1, day))
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
}

function iso(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Two-digit years map to 2000-2099. This journal has no pre-2000 history, and
 * a 1926 daily review is not a thing anyone is asking for.
 */
function expandYear(twoDigit) {
  return 2000 + twoDigit
}

export function parseDailyDateParam(value) {
  if (value === null || value === undefined) return null
  const raw = String(value).trim()
  if (!raw) return null

  const isoMatch = raw.match(ISO_RE)
  if (isoMatch) {
    const [, y, m, d] = isoMatch.map(Number)
    return isRealDate(y, m, d) ? iso(y, m, d) : null
  }

  if (!/^\d+$/.test(raw)) return null

  if (raw.length === 8) {
    // MMDDYYYY first — it is the canonical form. An impossible month means the
    // caller almost certainly wrote YYYYMMDD, so try that before giving up.
    const mm = Number(raw.slice(0, 2))
    const dd = Number(raw.slice(2, 4))
    const yyyy = Number(raw.slice(4))
    if (isRealDate(yyyy, mm, dd)) return iso(yyyy, mm, dd)

    const y2 = Number(raw.slice(0, 4))
    const m2 = Number(raw.slice(4, 6))
    const d2 = Number(raw.slice(6))
    if (isRealDate(y2, m2, d2)) return iso(y2, m2, d2)
    return null
  }

  if (raw.length === 7) {
    // MDDYYYY. Genuinely ambiguous against MMDYYYY ('1132026' could be Jan 13
    // or Nov 3), so pick one rule and stick to it: single-digit month wins
    // whenever the next two digits are a valid day. Deterministic beats clever.
    const yyyy = Number(raw.slice(3))
    const a = Number(raw.slice(0, 1))
    const bc = Number(raw.slice(1, 3))
    if (isRealDate(yyyy, a, bc)) return iso(yyyy, a, bc)

    const ab = Number(raw.slice(0, 2))
    const c = Number(raw.slice(2, 3))
    if (isRealDate(yyyy, ab, c)) return iso(yyyy, ab, c)
    return null
  }

  if (raw.length === 6) {
    // MMDDYY
    const mm = Number(raw.slice(0, 2))
    const dd = Number(raw.slice(2, 4))
    const yy = expandYear(Number(raw.slice(4)))
    if (isRealDate(yy, mm, dd)) return iso(yy, mm, dd)
    return null
  }

  return null
}

/** Canonical 8-digit form for building links: '2026-07-27' -> '07272026'. */
export function toDailyDateParam(isoDate) {
  const match = String(isoDate || '').match(ISO_RE)
  if (!match) return null
  const [, y, m, d] = match
  return `${m}${d}${y}`
}

export default { parseDailyDateParam, toDailyDateParam }
