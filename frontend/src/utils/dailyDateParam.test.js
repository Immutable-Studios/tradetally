import { describe, it, expect } from 'vitest'
import { parseDailyDateParam, toDailyDateParam } from './dailyDateParam'

describe('parseDailyDateParam', () => {
  it('parses the canonical 8-digit MMDDYYYY form', () => {
    expect(parseDailyDateParam('07272026')).toBe('2026-07-27')
    expect(parseDailyDateParam('12312026')).toBe('2026-12-31')
  })

  it('parses the 7-digit form with the leading zero dropped', () => {
    // The form in the original request.
    expect(parseDailyDateParam('7272026')).toBe('2026-07-27')
    expect(parseDailyDateParam('1012026')).toBe('2026-01-01')
  })

  it('resolves the 7-digit ambiguity in favour of a single-digit month', () => {
    // '1132026' could be Jan 13 or Nov 3; the documented rule picks Jan 13.
    expect(parseDailyDateParam('1132026')).toBe('2026-01-13')
  })

  it('falls back to a two-digit month when the single-digit read is impossible', () => {
    // '1152026' -> Jan 15 is valid, so that wins.
    expect(parseDailyDateParam('1152026')).toBe('2026-01-15')
    // '1232026' reads as Jan 23 or Dec 3; Jan 23 is valid, so it wins.
    expect(parseDailyDateParam('1232026')).toBe('2026-01-23')
    // '9312026' -> Sep 31 does not exist, so it must fall through and fail
    // rather than silently rolling into October.
    expect(parseDailyDateParam('9312026')).toBeNull()
  })

  it('parses MMDDYY', () => {
    expect(parseDailyDateParam('072726')).toBe('2026-07-27')
  })

  it('reads YYYYMMDD when MMDDYYYY would give an impossible month', () => {
    expect(parseDailyDateParam('20260727')).toBe('2026-07-27')
  })

  it('parses ISO', () => {
    expect(parseDailyDateParam('2026-07-27')).toBe('2026-07-27')
  })

  it('rejects dates that do not exist', () => {
    expect(parseDailyDateParam('02302026')).toBeNull()
    expect(parseDailyDateParam('13012026')).toBeNull()
    expect(parseDailyDateParam('2026-02-30')).toBeNull()
  })

  it('rejects junk', () => {
    expect(parseDailyDateParam('share')).toBeNull()
    expect(parseDailyDateParam('')).toBeNull()
    expect(parseDailyDateParam(null)).toBeNull()
    expect(parseDailyDateParam(undefined)).toBeNull()
    expect(parseDailyDateParam('123')).toBeNull()
    expect(parseDailyDateParam('072726abc')).toBeNull()
  })

  it('accepts a leap day in a leap year and rejects it otherwise', () => {
    expect(parseDailyDateParam('02292024')).toBe('2024-02-29')
    expect(parseDailyDateParam('02292026')).toBeNull()
  })
})

describe('toDailyDateParam', () => {
  it('builds the canonical link form', () => {
    expect(toDailyDateParam('2026-07-27')).toBe('07272026')
  })

  it('round-trips through the parser', () => {
    expect(parseDailyDateParam(toDailyDateParam('2026-03-09'))).toBe('2026-03-09')
  })

  it('returns null for anything that is not ISO', () => {
    expect(toDailyDateParam('7272026')).toBeNull()
    expect(toDailyDateParam(null)).toBeNull()
  })
})
