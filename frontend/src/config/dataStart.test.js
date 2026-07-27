import { describe, it, expect } from 'vitest'
import {
  DATA_START_DATE,
  DATA_START_DATE_LABEL,
  isBeforeDataStart,
  clampToDataStart
} from './dataStart'

describe('DATA_START_DATE', () => {
  it('is an ISO date', () => {
    expect(DATA_START_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('renders a label without shifting the day for users west of UTC', () => {
    // Parsed as UTC on purpose: a local parse turns 2026-07-25 into July 24
    // for anyone in the Americas.
    expect(DATA_START_DATE_LABEL).toContain('2026')
    expect(DATA_START_DATE_LABEL).toMatch(/July 25, 2026/)
  })
})

describe('isBeforeDataStart', () => {
  it('flags dates before the cutoff', () => {
    expect(isBeforeDataStart('2026-07-24')).toBe(true)
    expect(isBeforeDataStart('2024-01-01')).toBe(true)
  })

  it('accepts the cutoff itself and later', () => {
    expect(isBeforeDataStart(DATA_START_DATE)).toBe(false)
    expect(isBeforeDataStart('2026-07-26')).toBe(false)
  })

  it('reads the date portion of a timestamp', () => {
    expect(isBeforeDataStart('2026-07-24T23:59:59Z')).toBe(true)
    expect(isBeforeDataStart('2026-07-25T00:00:00Z')).toBe(false)
  })

  it('treats empty input as not-before, so a missing date is never dropped', () => {
    expect(isBeforeDataStart(null)).toBe(false)
    expect(isBeforeDataStart(undefined)).toBe(false)
    expect(isBeforeDataStart('')).toBe(false)
  })
})

describe('clampToDataStart', () => {
  it('raises an earlier date to the cutoff', () => {
    expect(clampToDataStart('2020-01-01')).toBe(DATA_START_DATE)
  })

  it('leaves a later date alone', () => {
    expect(clampToDataStart('2026-09-01')).toBe('2026-09-01')
  })

  it('treats empty as "all time" and returns the floor', () => {
    expect(clampToDataStart(null)).toBe(DATA_START_DATE)
    expect(clampToDataStart('')).toBe(DATA_START_DATE)
    expect(clampToDataStart(undefined)).toBe(DATA_START_DATE)
  })

  it('normalizes a timestamp down to its date', () => {
    expect(clampToDataStart('2026-09-01T13:45:00Z')).toBe('2026-09-01')
  })

  it('is idempotent', () => {
    expect(clampToDataStart(clampToDataStart('2020-01-01'))).toBe(DATA_START_DATE)
  })
})

describe('agreement with the backend constant', () => {
  it('matches backend/src/utils/dataStartDate.js', async () => {
    // The two constants are mirrored by hand; a silent drift would let the UI
    // promise data the API rejects.
    const backend = await import('../../../backend/src/utils/dataStartDate.js')
    expect(DATA_START_DATE).toBe(backend.DATA_START_DATE)
  })
})
