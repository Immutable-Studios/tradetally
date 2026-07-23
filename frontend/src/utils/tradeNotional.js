/**
 * Rough account notional for "% of equity" display.
 * Futures: |entry * qty * pointValue|; options: * contractSize (default 100).
 */

import { economicSide, isInverseEtf } from './inverseEtfs'

const FUTURES_POINT_VALUES = {
  ES: 50,
  NQ: 20,
  YM: 5,
  RTY: 50,
  MES: 5,
  MNQ: 2,
  MYM: 0.5,
  M2K: 5,
  CL: 1000,
  MCL: 100,
  NG: 10000,
  MNG: 1000,
  GC: 100,
  MGC: 10,
  SI: 5000,
  SIL: 1000
}

function extractFuturesRoot(symbol) {
  if (!symbol) return null
  const normalized = String(symbol).toUpperCase().replace(/^\//, '').split(':')[0]
  const match = normalized.match(/^([A-Z][A-Z0-9]{0,3})[FGHJKMNQUVXZ]\d{1,2}$/)
  return match ? match[1] : null
}

export function tradeNotional(trade) {
  const entry = Number(trade?.entry_price ?? trade?.entryPrice)
  const qty = Number(trade?.quantity)
  if (!Number.isFinite(entry) || !Number.isFinite(qty)) return null

  const instrumentType = String(trade?.instrument_type || trade?.instrumentType || 'stock').toLowerCase()
  let multiplier = 1

  if (instrumentType === 'future') {
    let pointValue = Number(trade?.point_value ?? trade?.pointValue)
    if (!Number.isFinite(pointValue) || pointValue <= 0) {
      const root = trade?.underlying_asset || trade?.underlyingAsset || extractFuturesRoot(trade?.symbol)
      pointValue = FUTURES_POINT_VALUES[String(root || '').toUpperCase()] || 1
    }
    multiplier = pointValue
  } else if (instrumentType === 'option') {
    const contractSize = Number(trade?.contract_size ?? trade?.contractSize)
    multiplier = Number.isFinite(contractSize) && contractSize > 0 ? contractSize : 100
  }

  return Math.abs(entry * qty * multiplier)
}

export function equityUsedPct(trade, equity) {
  const notional = tradeNotional(trade)
  const eq = Number(equity)
  if (notional == null || !Number.isFinite(eq) || eq <= 0) return null
  return Math.round((notional / eq) * 10000) / 100
}

/** Account equity % return for a dollar P&L (realized or unrealized). */
export function equityPnlPct(pnl, equity) {
  // Number(null) === 0 — treat missing P&L as unknown, not flat.
  if (pnl == null || pnl === '') return null
  const p = Number(pnl)
  const eq = Number(equity)
  if (!Number.isFinite(p) || !Number.isFinite(eq) || eq <= 0) return null
  return Math.round((p / eq) * 10000) / 100
}

/** Notional for a grouped open position (avg * qty * multiplier). */
export function positionNotional(position) {
  const sample = position?.trades?.[0] || position
  return tradeNotional({
    entry_price: position?.avgPrice ?? sample?.entry_price ?? sample?.entryPrice,
    quantity: position?.totalQuantity ?? sample?.quantity,
    instrument_type: sample?.instrument_type || sample?.instrumentType || 'stock',
    point_value: sample?.point_value ?? sample?.pointValue,
    contract_size: sample?.contract_size ?? sample?.contractSize,
    symbol: position?.symbol || sample?.symbol,
    underlying_asset: sample?.underlying_asset || sample?.underlyingAsset
  })
}

/**
 * Long / short % of equity from open positions.
 * Inverse ETF longs count as short exposure (and shorts of them as long).
 */
export function exposureEquityPercents(positions, equity) {
  const eq = Number(equity)
  if (!Number.isFinite(eq) || eq <= 0) {
    return { longEquityPct: null, shortEquityPct: null }
  }

  let longNotional = 0
  let shortNotional = 0

  for (const position of positions || []) {
    // Prefer live mark value when quotes are loaded; else entry notional.
    const mark = Number(position?.currentValue)
    const notional = Number.isFinite(mark) && mark !== 0
      ? Math.abs(mark)
      : positionNotional(position)
    if (notional == null || !Number.isFinite(notional) || notional <= 0) continue
    const side = economicSide(position.side, position.symbol)
    if (side === 'long') longNotional += notional
    else if (side === 'short') shortNotional += notional
  }

  return {
    longEquityPct: Math.round((longNotional / eq) * 10000) / 100,
    shortEquityPct: Math.round((shortNotional / eq) * 10000) / 100
  }
}

function positionMarkNotional(position) {
  const mark = Number(position?.currentValue)
  if (Number.isFinite(mark) && mark !== 0) return Math.abs(mark)
  return positionNotional(position)
}

/**
 * Compact open-book rows for the account pane: [{ symbol, equityPct, economicSide }…]
 * Sorted largest % first.
 */
export function openPositionEquityRows(positions, equity) {
  const eq = Number(equity)
  if (!Number.isFinite(eq) || eq <= 0) return []

  const rows = []
  for (const position of positions || []) {
    const notional = positionMarkNotional(position)
    if (notional == null || !Number.isFinite(notional) || notional <= 0) continue
    const symbol = position.symbol
    if (!symbol) continue
    rows.push({
      symbol,
      equityPct: Math.round((notional / eq) * 1000) / 10, // one decimal, e.g. 12.4
      economicSide: economicSide(position.side, symbol),
      inverse: isInverseEtf(symbol)
    })
  }

  return rows.sort((a, b) => b.equityPct - a.equityPct)
}
