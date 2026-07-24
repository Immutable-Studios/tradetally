/**
 * Utilities for futures contract handling
 */

/**
 * Get point value for futures contracts based on underlying asset
 * @param {string} underlying - The underlying asset symbol (e.g., 'ES', 'MES', 'NQ')
 * @returns {number} Point value in dollars per point
 */
const POINT_VALUES = {
  // E-mini contracts
  'ES': 50,      // E-mini S&P 500
  'NQ': 20,      // E-mini NASDAQ-100
  'YM': 5,       // E-mini Dow
  'RTY': 50,     // E-mini Russell 2000

  // Micro E-mini contracts (1/10th of E-mini)
  'MES': 5,      // Micro E-mini S&P 500 (10 Micros = 1 E-mini)
  'MNQ': 2,      // Micro E-mini NASDAQ-100 (10 Micros = 1 E-mini)
  'MYM': 0.5,    // Micro E-mini Dow (10 Micros = 1 E-mini)
  'M2K': 5,      // Micro E-mini Russell 2000 (10 Micros = 1 E-mini)

  // Energy
  'CL': 1000,    // Crude Oil
  'MCL': 100,    // Micro WTI Crude Oil (1/10th of CL)
  'NG': 10000,   // Natural Gas
  'MNG': 1000,   // Micro Natural Gas (1/10th of NG)
  'QG': 2500,    // Mini Natural Gas

  // Metals
  'GC': 100,     // Gold
  'MGC': 10,     // Micro Gold (1/10th of GC)
  'SI': 5000,    // Silver
  'SIL': 1000,   // Micro Silver
  'HG': 12500,   // Copper

  // Treasuries
  'ZB': 1000,    // 30-Year Treasury Bond
  'ZN': 1000,    // 10-Year Treasury Note
  'ZF': 1000,    // 5-Year Treasury Note
  'ZT': 2000     // 2-Year Treasury Note
};

function getFuturesPointValue(underlying) {
  if (!underlying) return 50; // Default to $50 if unknown
  return POINT_VALUES[underlying.toUpperCase()] || 50; // Default to $50 multiplier
}

/**
 * Whether a symbol is a known futures root (exact match against the point
 * value table). Roots collide with real stock tickers (CL, GC, SI...), so
 * callers must only use this behind an explicit futures context.
 */
function isKnownFuturesRoot(root) {
  if (!root) return false;
  return Object.prototype.hasOwnProperty.call(POINT_VALUES, root.toUpperCase());
}

/**
 * Resolve user input to a known futures root: accepts a bare root ("MNQ") or
 * a contract symbol ("MNQM6" -> "MNQ"). Returns null when the input is
 * neither a known root nor a contract whose extracted root is known.
 */
function resolveFuturesRoot(input) {
  if (!input) return null;
  const normalized = String(input).trim().toUpperCase();
  if (isKnownFuturesRoot(normalized)) return normalized;
  const extracted = extractUnderlyingFromFuturesSymbol(normalized);
  return extracted && isKnownFuturesRoot(extracted) ? extracted : null;
}

/**
 * Micro roots → full-size continuous roots (same index price levels).
 * Used when Schwab/TOS continuous history is requested as /ES or /NQ.
 */
const MICRO_TO_FULL_ROOT = {
  MES: 'ES',
  MNQ: 'NQ',
  MYM: 'YM',
  M2K: 'RTY',
  MCL: 'CL',
  MNG: 'NG',
  MGC: 'GC',
  SIL: 'SI'
};

/**
 * Ordered Schwab/TOS-style continuous symbols to try for chart candles.
 * Contract months like MESU26 often have no pricehistory; continuous
 * `/MES`, `/ES`, `!MES`, `!ES` do.
 * @returns {string[]} empty when symbol is not a futures contract/root
 */
function getContinuousChartSymbolCandidates(symbol) {
  const root = resolveFuturesRoot(symbol) || extractUnderlyingFromFuturesSymbol(symbol);
  if (!root) return [];

  const roots = [root];
  const full = MICRO_TO_FULL_ROOT[root];
  if (full) roots.push(full);

  const candidates = [];
  const push = (value) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };

  for (const r of roots) {
    push(`/${r}`);
  }
  for (const r of roots) {
    push(`!${r}`);
  }
  for (const r of roots) {
    push(r);
  }

  return candidates;
}

/**
 * Get minimum tick size for futures contracts based on underlying asset.
 * Returns the price increment of one tick (in points), or null if unknown.
 * Returning null (rather than a guessed default) is deliberate: tick sizes vary
 * widely across contracts, and a wrong value would distort breakeven tolerance.
 * @param {string} underlying - The underlying asset symbol (e.g., 'ES', 'MNQ')
 * @returns {number|null} Tick size in points, or null if unknown
 */
function getFuturesTickSize(underlying) {
  if (!underlying) return null;

  const upperUnderlying = underlying.toUpperCase();

  const tickSizes = {
    // E-mini equity index
    'ES': 0.25,    // E-mini S&P 500
    'NQ': 0.25,    // E-mini NASDAQ-100
    'YM': 1,       // E-mini Dow
    'RTY': 0.1,    // E-mini Russell 2000

    // Micro E-mini equity index
    'MES': 0.25,   // Micro E-mini S&P 500
    'MNQ': 0.25,   // Micro E-mini NASDAQ-100
    'MYM': 1,      // Micro E-mini Dow
    'M2K': 0.1,    // Micro E-mini Russell 2000

    // Energy
    'CL': 0.01,    // Crude Oil
    'MCL': 0.01,   // Micro WTI Crude Oil
    'NG': 0.001,   // Natural Gas
    'MNG': 0.001,  // Micro Natural Gas
    'QG': 0.005,   // Mini Natural Gas

    // Metals
    'GC': 0.1,     // Gold
    'MGC': 0.1,    // Micro Gold
    'SI': 0.005,   // Silver
    'SIL': 0.005,  // Micro Silver
    'HG': 0.0005,  // Copper

    // Treasuries (fractional ticks)
    'ZB': 0.03125,    // 30-Year T-Bond (1/32)
    'ZN': 0.015625,   // 10-Year T-Note (1/64)
    'ZF': 0.0078125,  // 5-Year T-Note (1/128)
    'ZT': 0.00390625  // 2-Year T-Note (1/256)
  };

  return tickSizes[upperUnderlying] ?? null;
}

/**
 * Extract underlying asset from a futures contract symbol
 * Handles formats like: ESM4, NQU24, MESZ5, CLZ23, M2KM6, etc.
 * @param {string} symbol - The futures contract symbol
 * @returns {string|null} The underlying asset symbol or null if not a futures format
 */
const FUTURES_MONTH_CODES = {
  F: '01', G: '02', H: '03', J: '04', K: '05', M: '06',
  N: '07', Q: '08', U: '09', V: '10', X: '11', Z: '12'
};

/**
 * Strip Schwab/TOS exchange suffixes and leading slash: `/MESU26:XCME` → `MESU26`.
 */
function normalizeFuturesContractSymbol(symbol) {
  if (!symbol) return null;
  let normalizedSymbol = symbol.toString().toUpperCase().trim().replace(/\s+/g, '');
  if (normalizedSymbol.startsWith('/')) {
    normalizedSymbol = normalizedSymbol.slice(1);
  }
  const colonIdx = normalizedSymbol.indexOf(':');
  if (colonIdx > 0) {
    normalizedSymbol = normalizedSymbol.slice(0, colonIdx);
  }
  return normalizedSymbol || null;
}

function resolveFuturesYear(yearToken) {
  let year = parseInt(yearToken, 10);
  if (!Number.isFinite(year)) return null;
  if (year < 10) {
    year += Math.floor(new Date().getFullYear() / 10) * 10;
  } else if (year < 100) {
    year += 2000;
  }
  return year;
}

/**
 * Parse root / month / year from a futures contract symbol.
 * @returns {{ underlyingAsset: string, contractMonth: string, contractYear: number }|null}
 */
function parseFuturesContractFields(symbol) {
  const normalizedSymbol = normalizeFuturesContractSymbol(symbol);
  if (!normalizedSymbol) return null;

  // Standard: MESU26, NQU24, ESM4, M2KM6
  const futuresMatch = normalizedSymbol.match(/^([A-Z][A-Z0-9]{0,3})([FGHJKMNQUVXZ])(\d{1,2})$/);
  if (!futuresMatch) return null;

  const underlyingAsset = futuresMatch[1];
  const contractMonth = FUTURES_MONTH_CODES[futuresMatch[2]] || null;
  const contractYear = resolveFuturesYear(futuresMatch[3]);
  if (!contractMonth || !contractYear) return null;

  return { underlyingAsset, contractMonth, contractYear };
}

function extractUnderlyingFromFuturesSymbol(symbol) {
  if (!symbol) return null;

  const parsed = parseFuturesContractFields(symbol);
  if (parsed) {
    return parsed.underlyingAsset;
  }

  let normalizedSymbol = normalizeFuturesContractSymbol(symbol) || '';

  // TradingView format: NYMEX_MINI:QG1!
  const tvMatch = normalizedSymbol.match(/^([A-Z_]+):([A-Z]+)(\d+)/);
  if (tvMatch) {
    const underlying = tvMatch[2];
    // Extract just the letters if there are numbers mixed in
    const letterMatch = underlying.match(/^([A-Z]+)/);
    return letterMatch ? letterMatch[1] : underlying;
  }

  // If symbol doesn't match futures pattern, return null
  return null;
}

/**
 * Approximate CME equity-index quarterly expiry: 3rd Friday of the contract month (UTC).
 * Good enough to detect rolled/expired contracts that cannot still be open.
 */
function getFuturesContractExpiryDate(symbolOrFields) {
  const fields = typeof symbolOrFields === 'string'
    ? parseFuturesContractFields(symbolOrFields)
    : symbolOrFields;
  if (!fields?.contractMonth || !fields?.contractYear) return null;

  const year = Number(fields.contractYear);
  const monthIndex = Number(fields.contractMonth) - 1; // 0-based
  if (!Number.isFinite(year) || monthIndex < 0 || monthIndex > 11) return null;

  const first = new Date(Date.UTC(year, monthIndex, 1));
  const dayOfWeek = first.getUTCDay(); // 0=Sun … 5=Fri
  const firstFriday = 1 + ((5 - dayOfWeek + 7) % 7);
  const thirdFriday = firstFriday + 14;
  return new Date(Date.UTC(year, monthIndex, thirdFriday, 23, 59, 59, 999));
}

/**
 * True when the contract is past its approximate expiry (cannot be a live open).
 */
function isFuturesContractExpired(symbol, asOf = new Date()) {
  const expiry = getFuturesContractExpiryDate(symbol);
  if (!expiry) return false;
  return asOf.getTime() > expiry.getTime();
}

module.exports = {
  getFuturesPointValue,
  getFuturesTickSize,
  extractUnderlyingFromFuturesSymbol,
  parseFuturesContractFields,
  normalizeFuturesContractSymbol,
  getFuturesContractExpiryDate,
  isFuturesContractExpired,
  isKnownFuturesRoot,
  resolveFuturesRoot,
  getContinuousChartSymbolCandidates
};

