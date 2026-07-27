// Viewport geometry for the padded inline trade chart.
//
// Extracted from KLineTradeChart so it can be tested without a chart engine:
// getting this wrong is invisible in code review and very visible on screen.
// The bug it exists to prevent — a fixed visible-bar count that showed only
// the last three hours of a two-session series, leaving the prior day loaded
// but scrolled off to the left.

// Floor, not a target. Set at 1px so a full futures session fits: two days of
// 5-minute /MNQ candles is ~450-580 bars, which needs ~1.2-1.6px each in a
// typical inline chart. A 2px floor pushed that over the edge and pinned the
// view to the right, hiding the prior day all over again. Only a pathological
// multi-week series hits this floor, and that one scrolls rather than shrink
// into nothing.
const MIN_BAR_SPACE = 1
// Never stretch beyond this or a short series turns into a handful of planks.
const MAX_BAR_SPACE = 18
// Keeps a nearly-empty series from rendering edge to edge.
const MIN_VISIBLE_BARS = 24

/**
 * @param {object} input
 * @param {number} input.barCount        loaded candles (excluding synthetic pad)
 * @param {number} input.rightPaddingBars synthetic empty bars on the right
 * @param {number} input.availableWidth  usable pixel width of the plot area
 * @returns {{barSpace: number, maxOffsetRight: number, offsetRight: number, visibleBars: number}}
 */
export function paddedViewport({ barCount, rightPaddingBars, availableWidth }) {
  const bars = Math.max(0, Number(barCount) || 0)
  const rightPad = Math.max(0, Number(rightPaddingBars) || 0)
  const width = Math.max(1, Number(availableWidth) || 0)

  // Fit the entire loaded series plus its padding, rather than a fixed count.
  const visibleBars = Math.max(MIN_VISIBLE_BARS, bars + rightPad)
  const barSpace = Math.max(MIN_BAR_SPACE, Math.min(MAX_BAR_SPACE, width / visibleBars))

  return {
    barSpace,
    visibleBars,
    maxOffsetRight: barSpace * rightPad,
    // Show a few empty bars past the last candle without letting the series
    // drift off the left edge.
    offsetRight: barSpace * Math.min(4, rightPad)
  }
}

export default { paddedViewport }
