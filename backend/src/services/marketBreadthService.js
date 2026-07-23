/**
 * Market Breadth board — Jeff Sun (jfsrev) top-down RS sheet methodology.
 *
 * Sources:
 * - Spreadsheet tutorial: RS vs SPY over ~25 trading days (WORKDAY -27)
 *   https://x.com/jfsrev/status/1806709652975141131
 * - RS_Strength % (Yang): last RS vs min/max of the 25-day RS series
 *   https://x.com/jfsrev/status/1812759804395528495
 * - RS Thrust Rate %: blend of 1-week + 1-month RS (~60/40 recency) plus a
 *   small adjustment from 1-week RS change vs 3 sessions ago. Exact weights
 *   are still being fine-tuned publicly; we implement the described shape.
 *   https://x.com/jfsrev/status/2064559372655866303
 * - Universe layout matches the live bird's-eye sheet (Index → Segment →
 *   EW Sector → SPDR Sector → Group). Full 100+ industry ETF list is separate.
 */

const schwabMarketData = require('../utils/schwabMarketData');

const BENCHMARK = 'SPY';
const HISTORY_TTL_MS = 30 * 60 * 1000;
const RS_DAYS = 25; // ~1 month of sessions (Jeff: WORKDAY(TODAY(), -27))
const SPARKLINE_POINTS = 25;

/** @type {{ expiresAt: number, bySymbol: Record<string, { closes: number[] }> }} */
let historyCache = { expiresAt: 0, bySymbol: {} };

/** Bird's-eye sheet universe (screenshot order / labels). */
const SECTIONS = [
  {
    id: 'index',
    label: 'Index',
    sortable: false,
    rows: [
      { symbol: 'RSP', name: 'S&P 500 Equal Weight' },
      { symbol: 'SPY', name: 'S&P 500', note: 'rs reference' },
      { symbol: 'QQQ', name: 'Nasdaq-100' },
      { symbol: 'QQQE', name: 'Nasdaq-100 Equal Weight' },
      { symbol: 'IWM', name: 'Russell 2000' },
      { symbol: 'DIA', name: 'Dow 30' },
      { symbol: 'SPMO', name: 'S&P 500 Momentum' },
      { symbol: 'TLT', name: '20+ Year Treasury Bonds' }
    ]
  },
  {
    id: 'segment',
    label: 'Segment',
    sortable: false, // Jeff: leave segment order (small→large) for visual progression
    rows: [
      { symbol: 'IJS', name: 'Small-Cap 600 Value' },
      { symbol: 'IJR', name: 'Small-Cap 600' },
      { symbol: 'IJT', name: 'Small-Cap 600 Growth' },
      { symbol: 'IJJ', name: 'Mid-Cap 400 Value' },
      { symbol: 'IJH', name: 'Mid-Cap 400' },
      { symbol: 'IJK', name: 'Mid-Cap 400 Growth' },
      { symbol: 'IVE', name: 'Large-Cap 500 Value' },
      { symbol: 'IVV', name: 'S&P 500' },
      { symbol: 'IVW', name: 'Large-Cap 500 Growth' }
    ]
  },
  {
    id: 'ew_sector',
    label: 'EW Sector',
    sortable: true, // sort by 1-Mth RS, then Thrust
    rows: [
      { symbol: 'RSPG', name: 'Equal Weight Energy' },
      { symbol: 'RSPF', name: 'Equal Weight Financials' },
      { symbol: 'RSPS', name: 'Equal Weight Staples' },
      { symbol: 'RSPR', name: 'Equal Weight Real Estate' },
      { symbol: 'RSPC', name: 'Equal Weight Communication' },
      { symbol: 'RSPH', name: 'Equal Weight Health Care' },
      { symbol: 'SPY', name: 'S&P 500', note: 'reference' },
      { symbol: 'RSPD', name: 'Equal Weight Discretionary' },
      { symbol: 'RSPM', name: 'Equal Weight Materials' },
      { symbol: 'RSPT', name: 'Equal Weight Technology' },
      { symbol: 'RSPU', name: 'Equal Weight Utilities' },
      { symbol: 'RSPN', name: 'Equal Weight Industrials' }
    ]
  },
  {
    id: 'spdr_sector',
    label: 'SPDR Sector',
    sortable: true,
    rows: [
      { symbol: 'XLE', name: 'Energy' },
      { symbol: 'XLRE', name: 'Real Estate' },
      { symbol: 'XLF', name: 'Financials' },
      { symbol: 'XLP', name: 'Consumer Staples' },
      { symbol: 'XLC', name: 'Communication Services' },
      { symbol: 'XLV', name: 'Health Care' },
      { symbol: 'SPY', name: 'S&P 500', note: 'reference' },
      { symbol: 'XLU', name: 'Utilities' },
      { symbol: 'XLK', name: 'Technology' },
      { symbol: 'XLI', name: 'Industrials' },
      { symbol: 'XLB', name: 'Materials' },
      { symbol: 'XLY', name: 'Consumer Discretionary' }
    ]
  },
  {
    id: 'group',
    label: 'Group',
    sortable: true,
    rows: [
      { symbol: 'KIE', name: 'Insurance' },
      { symbol: 'PBJ', name: 'Food & Beverage' },
      { symbol: 'FCG', name: 'Natural Gas E&P' },
      { symbol: 'AMLP', name: 'Energy MLPs' },
      { symbol: 'XOP', name: 'Oil & Gas E&P', highlight: true },
      { symbol: 'WCLD', name: 'Cloud Tech' }
    ]
  }
];

function allSymbols() {
  const set = new Set([BENCHMARK]);
  for (const section of SECTIONS) {
    for (const row of section.rows) set.add(row.symbol);
  }
  return [...set];
}

function round1(n) {
  if (n == null || Number.isNaN(n)) return null;
  return Math.round(n * 10) / 10;
}

function pctChange(from, to) {
  if (from == null || to == null || from === 0) return null;
  return ((to - from) / from) * 100;
}

function downsample(values, points) {
  if (!values?.length) return [];
  if (values.length <= points) return [...values];
  const step = (values.length - 1) / (points - 1);
  const out = [];
  for (let i = 0; i < points; i++) {
    out.push(values[Math.round(i * step)]);
  }
  return out;
}

/** Align last N closes for ticker vs benchmark → daily RS ratios (ticker/SPY). */
function rsRatios(symbolCloses, benchCloses, days = RS_DAYS) {
  if (!symbolCloses?.length || !benchCloses?.length) return [];
  const n = Math.min(symbolCloses.length, benchCloses.length, days);
  const s = symbolCloses.slice(-n);
  const b = benchCloses.slice(-n);
  const out = [];
  for (let i = 0; i < n; i++) {
    if (b[i]) out.push(s[i] / b[i]);
  }
  return out;
}

/** Yang RS_Strength %: where last RS sits in the window's min–max (0–100). */
function rsStrengthPct(rs) {
  if (!rs?.length) return null;
  const last = rs[rs.length - 1];
  const min = Math.min(...rs);
  const max = Math.max(...rs);
  if (max === min) return 50;
  return ((last - min) / (max - min)) * 100;
}

/**
 * Approximate RS Thrust Rate % from Jeff's public description (60/40 week/month
 * + 0.1 × change in 1-week RS strength vs 3 sessions ago). Not his private final model.
 */
function approxRsThrust(rs) {
  if (!rs || rs.length < 8) return null;
  const month = rs.slice(-RS_DAYS);
  const week = rs.slice(-5);
  const weekAsOf3Ago = rs.slice(-8, -3); // 5-day window ending 3 sessions ago
  if (weekAsOf3Ago.length < 5) return null;

  const stsMonth = rsStrengthPct(month);
  const stsWeek = rsStrengthPct(week);
  const stsWeekPrev = rsStrengthPct(weekAsOf3Ago);
  if (stsMonth == null || stsWeek == null || stsWeekPrev == null) return null;

  return 0.6 * stsWeek + 0.4 * stsMonth + 0.1 * (stsWeek - stsWeekPrev);
}

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}

async function loadHistory(symbols) {
  const now = Date.now();
  if (historyCache.expiresAt > now && symbols.every((s) => historyCache.bySymbol[s])) {
    return historyCache.bySymbol;
  }

  const to = Math.floor(now / 1000);
  // Extra calendar buffer so we still get ≥25 sessions around holidays
  const from = to - 55 * 24 * 60 * 60;
  const bySymbol = { ...historyCache.bySymbol };

  await mapPool(symbols, 4, async (symbol) => {
    if (bySymbol[symbol] && historyCache.expiresAt > now) return;
    try {
      const candles = await schwabMarketData.getCandles(symbol, 'D', from, to);
      if (!candles?.length) {
        bySymbol[symbol] = { closes: [] };
        return;
      }
      bySymbol[symbol] = {
        closes: candles.map((c) => c.close).filter((c) => typeof c === 'number')
      };
    } catch (err) {
      console.warn(`[MARKET-BREADTH] History failed for ${symbol}:`, err.message);
      bySymbol[symbol] = bySymbol[symbol] || { closes: [] };
    }
  });

  historyCache = { expiresAt: now + HISTORY_TTL_MS, bySymbol };
  return bySymbol;
}

function buildRow(row, quotes, history, benchCloses) {
  const q = quotes[row.symbol] || quotes[row.symbol.toUpperCase()] || null;
  const closes = history[row.symbol]?.closes || [];
  const last = q?.c ?? null;
  const high52 = q?.high52 ?? null;
  const pctIntraday = q?.dp != null ? round1(q.dp) : null;

  // Prior session return (distinct from live intraday %)
  let pct1d = null;
  if (closes.length >= 2) {
    pct1d = round1(pctChange(closes[closes.length - 2], closes[closes.length - 1]));
  }

  const isBench = row.symbol === BENCHMARK;
  const rs = isBench ? [] : rsRatios(closes, benchCloses, RS_DAYS);
  const rs1m =
    !isBench && rs.length >= 2
      ? round1(pctChange(rs[0], rs[rs.length - 1]))
      : null;
  const rsThrust = isBench ? null : round1(approxRsThrust(rs));
  const rsSts = isBench ? null : round1(rsStrengthPct(rs));

  const monthCloses = closes.slice(-RS_DAYS);
  const pct1m =
    monthCloses.length >= 2
      ? round1(pctChange(monthCloses[0], monthCloses[monthCloses.length - 1]))
      : null;
  const pctOff52w =
    last != null && high52 ? round1(pctChange(high52, last)) : null;

  return {
    symbol: row.symbol,
    name: row.name,
    note: row.note || null,
    highlight: Boolean(row.highlight),
    price: last,
    rsThrust,
    rsSts,
    rs1m,
    sparkline: downsample(monthCloses, SPARKLINE_POINTS),
    rsSparkline: downsample(rs, SPARKLINE_POINTS),
    pctIntraday,
    pct1d,
    pct1m,
    pctOff52w
  };
}

function sortRows(rows) {
  // Dual-layer: 1-Mth RS desc, then Thrust desc. Keep SPY reference rows pinned last.
  const refs = rows.filter((r) => r.symbol === BENCHMARK);
  const rest = rows.filter((r) => r.symbol !== BENCHMARK);
  rest.sort((a, b) => {
    const ra = a.rs1m ?? -Infinity;
    const rb = b.rs1m ?? -Infinity;
    if (rb !== ra) return rb - ra;
    return (b.rsThrust ?? -Infinity) - (a.rsThrust ?? -Infinity);
  });
  return [...rest, ...refs];
}

async function getBoard() {
  const connection = await schwabMarketData.getActiveConnection();
  if (!connection) {
    return {
      ok: false,
      error: 'No active Schwab connection. Connect Schwab under Broker Sync.',
      needsReauth: true,
      asOf: new Date().toISOString(),
      sections: []
    };
  }

  const { accessToken, needsReauth } = await schwabMarketData.ensureValidToken(connection);
  if (needsReauth || !accessToken) {
    return {
      ok: false,
      error: 'Schwab token expired. Re-connect Schwab under Broker Sync.',
      needsReauth: true,
      asOf: new Date().toISOString(),
      sections: []
    };
  }

  const symbols = allSymbols();
  const [quotes, history] = await Promise.all([
    schwabMarketData.getQuotes(symbols),
    loadHistory(symbols)
  ]);

  const benchCloses = history[BENCHMARK]?.closes || [];

  const sections = SECTIONS.map((section) => {
    let rows = section.rows.map((row) =>
      buildRow(row, quotes, history, benchCloses)
    );
    if (section.sortable) rows = sortRows(rows);
    return {
      id: section.id,
      label: section.label,
      rows
    };
  });

  const quoteCount = Object.keys(quotes).length;
  return {
    ok: quoteCount > 0,
    error: quoteCount > 0 ? null : 'Schwab returned no quotes. Check Market Data access.',
    needsReauth: false,
    asOf: new Date().toISOString(),
    benchmark: BENCHMARK,
    source: 'schwab',
    methodology: {
      rsWindowDays: RS_DAYS,
      rsBenchmark: BENCHMARK,
      rsThrust:
        'Approx. 60% 1-week RS_Strength + 40% 1-month RS_Strength + 0.1×Δ(1-week RS_Strength vs 3 sessions ago). Jeff has not published the final calibrated formula.',
      rs1m: '(RS_last / RS_first − 1) where RS_t = close_t / SPY_t over ~25 sessions',
      rsStrength: 'Yang RS_Strength %: (RS_last − min) / (max − min) over the RS window'
    },
    sections
  };
}

module.exports = {
  getBoard,
  SECTIONS,
  allSymbols,
  rsRatios,
  rsStrengthPct,
  approxRsThrust
};
