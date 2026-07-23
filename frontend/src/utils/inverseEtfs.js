/**
 * Known inverse / bear ETFs. A long in these is economic short exposure;
 * a short is economic long.
 */
const INVERSE_ETF_SYMBOLS = new Set([
  // Equity index bear
  'SH', 'SDS', 'SPXU', 'SPXS', 'SDOW', 'DXD', 'DOG', 'SARK',
  'PSQ', 'QID', 'SQQQ', 'RWM', 'TWM', 'TZA', 'SRTY',
  // Sector / thematic bear
  'SOXS', 'TECS', 'FAZ', 'LABD', 'BERZ', 'CARD', 'WEBS',
  'YANG', 'EDZ', 'EEV', 'EPV', 'EFU', 'EUM', 'EWV',
  'BIS', 'SCC', 'SSG', 'SDP', 'SZK', 'SIJ', 'SKF', 'SEF',
  'FXP', 'YANG', 'KOLD', 'DUST', 'JDST', 'CNY', 'BZQ',
  'GASX', 'DRIP', 'OILD', 'SCO', 'ZSL', 'GLL', 'DZZ',
  // Crypto bear
  'BITI', 'SBIT',
  // Rates / bond bear (price falls when yields rise — treat as inverse of bonds)
  'TBT', 'TBF', 'TMV', 'TTT', 'TBX'
])

export function isInverseEtf(symbol) {
  if (!symbol) return false
  return INVERSE_ETF_SYMBOLS.has(String(symbol).toUpperCase().trim())
}

/** Broker side label with inverse tag, e.g. "long (INVERSE)". */
export function sideLabel(side, symbol) {
  const normalized = String(side || '').toLowerCase()
  const base = normalized === 'neutral' || normalized === 'hedged'
    ? 'hedged'
    : (normalized === 'short' || normalized === 'sell' ? 'short' : 'long')
  return isInverseEtf(symbol) ? `${base} (INVERSE)` : base
}

/**
 * Economic direction for exposure: inverse ETF longs count as short, etc.
 * @returns {'long'|'short'|'neutral'}
 */
export function economicSide(side, symbol) {
  const normalized = String(side || '').toLowerCase()
  if (normalized === 'neutral' || normalized === 'hedged') return 'neutral'

  const isShort = normalized === 'short' || normalized === 'sell'
  if (isInverseEtf(symbol)) return isShort ? 'long' : 'short'
  return isShort ? 'short' : 'long'
}
