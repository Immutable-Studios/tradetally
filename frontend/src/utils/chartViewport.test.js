import { describe, it, expect } from 'vitest'
import { paddedViewport } from './chartViewport'

// The inline daily-review chart: 20 synthetic pad bars, ~700px of plot area.
const INLINE = { rightPaddingBars: 20, availableWidth: 700 }

describe('paddedViewport', () => {
  it('fits the entire loaded series on screen', () => {
    // 156 bars is a real case: two RTH sessions of 5-minute candles, i.e. the
    // prior day plus the execution day.
    const view = paddedViewport({ barCount: 156, ...INLINE })

    expect(view.barSpace * (156 + 20)).toBeLessThanOrEqual(INLINE.availableWidth + 0.001)
    expect(view.visibleBars).toBe(176)
  })

  it('shows the prior session, not just the last few hours', () => {
    // The regression: a fixed 36-bar window put ~3 hours on screen and left the
    // rest scrolled off to the left.
    const view = paddedViewport({ barCount: 156, ...INLINE })

    const barsOnScreen = INLINE.availableWidth / view.barSpace
    expect(barsOnScreen).toBeGreaterThan(150)
  })

  it('fits a full futures session', () => {
    // 429 bars — nearly 24h of 5-minute candles, as returned for /MES. This is
    // the case a 2px floor could not fit, which pinned the view to the right
    // edge and hid the prior day.
    const view = paddedViewport({ barCount: 429, ...INLINE })

    expect(view.barSpace * (429 + 20)).toBeLessThanOrEqual(INLINE.availableWidth + 0.001)
  })

  it('fits two days of futures candles', () => {
    const view = paddedViewport({ barCount: 576, ...INLINE })

    expect(view.barSpace * (576 + 20)).toBeLessThanOrEqual(INLINE.availableWidth + 0.001)
    expect(view.barSpace).toBeGreaterThan(1)
  })

  it('compresses rather than clips once the bar-space floor is reached', () => {
    // A pathological multi-week series cannot fit; it shrinks to the floor and
    // scrolls, never silently dropping the early bars.
    const view = paddedViewport({ barCount: 5000, ...INLINE })

    expect(view.barSpace).toBe(1)
    expect(view.visibleBars).toBe(5020)
  })

  it('does not stretch a short series into planks', () => {
    const view = paddedViewport({ barCount: 3, ...INLINE })

    expect(view.barSpace).toBe(18)
  })

  it('keeps a floor on visible bars so a tiny series is not edge to edge', () => {
    expect(paddedViewport({ barCount: 0, rightPaddingBars: 0, availableWidth: 700 }).visibleBars).toBe(24)
  })

  it('reserves the right-hand padding', () => {
    const view = paddedViewport({ barCount: 100, ...INLINE })

    expect(view.maxOffsetRight).toBeCloseTo(view.barSpace * 20, 6)
    // Only a few empty bars are shown initially, not the full pad.
    expect(view.offsetRight).toBeCloseTo(view.barSpace * 4, 6)
  })

  it('caps the initial offset at the pad when padding is small', () => {
    const view = paddedViewport({ barCount: 100, rightPaddingBars: 2, availableWidth: 700 })

    expect(view.offsetRight).toBeCloseTo(view.barSpace * 2, 6)
  })

  it('never returns a negative or zero bar space', () => {
    for (const input of [
      { barCount: -5, rightPaddingBars: -3, availableWidth: -100 },
      { barCount: NaN, rightPaddingBars: NaN, availableWidth: NaN },
      { barCount: undefined, rightPaddingBars: undefined, availableWidth: undefined }
    ]) {
      const view = paddedViewport(input)
      expect(view.barSpace).toBeGreaterThan(0)
      expect(view.maxOffsetRight).toBeGreaterThanOrEqual(0)
      expect(view.offsetRight).toBeGreaterThanOrEqual(0)
    }
  })

  it('gives a narrow container less space per bar than a wide one', () => {
    const narrow = paddedViewport({ barCount: 156, rightPaddingBars: 20, availableWidth: 320 })
    const wide = paddedViewport({ barCount: 156, rightPaddingBars: 20, availableWidth: 1400 })

    expect(narrow.barSpace).toBeLessThan(wide.barSpace)
  })
})
