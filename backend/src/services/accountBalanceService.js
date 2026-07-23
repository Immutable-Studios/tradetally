/**
 * Schwab account balances → daily-review strip + equity denominator for
 * trade "% of equity" metrics.
 *
 * TOS Net Liq matches Schwab's account-level aggregatedBalance.liquidationValue
 * (includes futures). Per-account currentBalances.liquidationValue is securities-
 * only and understates Net Liq when futures are open.
 */

const db = require('../config/database');
const BrokerConnection = require('../models/BrokerConnection');
const schwabService = require('./brokerSync/schwabService');
const {
  getFuturesPointValue,
  extractUnderlyingFromFuturesSymbol
} = require('../utils/futuresUtils');

function round2(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.round(num * 100) / 100 : null;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse one Schwab account row into a flat balance strip.
 * Accepts either the raw /accounts element ({ securitiesAccount, aggregatedBalance })
 * or a bare securitiesAccount object.
 */
function parseSchwabAccount(accountRow) {
  const securitiesAccount = accountRow?.securitiesAccount || accountRow || {};
  const aggregated = accountRow?.aggregatedBalance || {};
  const current = securitiesAccount?.currentBalances || {};
  const initial = securitiesAccount?.initialBalances || {};
  const projected = securitiesAccount?.projectedBalances || {};
  const accountNumber = securitiesAccount?.accountNumber;
  const last4 = accountNumber ? String(accountNumber).slice(-4) : null;
  const masked = last4 ? `****${last4}` : null;

  // Securities-only book (cash + stock/options). Omits futures.
  const securitiesNetLiq = num(current.liquidationValue) ?? num(current.equity);
  // TOS-style Net Liq: aggregated includes futures contribution on futures-enabled accounts.
  const aggregatedNetLiq = num(aggregated.currentLiquidationValue) ?? num(aggregated.liquidationValue);
  const netLiq = aggregatedNetLiq ?? securitiesNetLiq;

  // Schwab only publishes SOD for the securities book (not aggregated/TOS Net Liq).
  const sodNetLiq = num(initial.liquidationValue) ?? num(initial.equity) ?? num(initial.accountValue);
  const futuresBalance = (aggregatedNetLiq != null && securitiesNetLiq != null)
    ? round2(aggregatedNetLiq - securitiesNetLiq)
    : null;

  const cash = num(current.cashBalance);
  const availableFunds = num(current.availableFunds) ?? num(projected.availableFunds);
  const buyingPower = num(current.buyingPower) ?? num(projected.buyingPower);
  const aggregatedIntradayBp = num(aggregated.currentIntradayBuyingPowerAmount)
    ?? num(aggregated.intradayBuyingPowerAmount);
  const intradayBuyingPower = aggregatedIntradayBp
    ?? num(current.intradayBuyingPowerAmount)
    ?? num(current.dayTradingBuyingPower)
    ?? num(projected.dayTradingBuyingPower);
  const longStockValue = num(current.longMarketValue);
  const shortBalance = num(current.shortBalance) ?? num(current.shortMarketValue) ?? 0;

  return {
    account: masked,
    type: securitiesAccount?.type || null,
    netLiq: round2(netLiq),
    securitiesNetLiq: round2(securitiesNetLiq),
    sodNetLiq: round2(sodNetLiq),
    cash: round2(cash),
    availableFunds: round2(availableFunds),
    buyingPower: round2(buyingPower),
    intradayBuyingPower: round2(intradayBuyingPower),
    longStockValue: round2(longStockValue),
    shortBalance: round2(shortBalance),
    // Populated later by computeTradingDayPl (journal realized + open day marks).
    dayPl: null,
    realizedPl: null,
    openDayPl: null,
    // Kept only as an internal diagnostic (aggregated − securities). Not shown in UI.
    _futuresNetLiqGap: futuresBalance != null && Math.abs(futuresBalance) > 0.005
      ? futuresBalance
      : null
  };
}

function sumAccounts(accounts) {
  const pick = (key) => {
    const values = accounts.map((a) => a[key]).filter((v) => v != null && Number.isFinite(Number(v)));
    if (!values.length) return null;
    return round2(values.reduce((sum, v) => sum + Number(v), 0));
  };

  return {
    netLiq: pick('netLiq'),
    sodNetLiq: pick('sodNetLiq'),
    cash: pick('cash'),
    availableFunds: pick('availableFunds'),
    buyingPower: pick('buyingPower'),
    intradayBuyingPower: pick('intradayBuyingPower'),
    longStockValue: pick('longStockValue'),
    shortBalance: pick('shortBalance'),
    dayPl: null,
    realizedPl: null,
    openDayPl: null,
    accounts
  };
}

/**
 * Journal realized P/L for exits on shareDate in the user's timezone.
 */
async function sumRealizedPlForDay(userId, shareDate, timezone) {
  const tz = timezone || 'UTC';
  const excluded = await BrokerConnection.getExcludedAccountIdentifiers(userId).catch(() => []);
  const params = [userId, tz, shareDate];
  let accountClause = '';
  if (excluded.length > 0) {
    params.push(excluded);
    accountClause = ` AND (account_identifier IS NULL OR account_identifier = '' OR account_identifier <> ALL($4::text[]))`;
  }
  const result = await db.query(
    `SELECT COALESCE(SUM(pnl), 0)::float AS realized
     FROM trades
     WHERE user_id = $1
       AND exit_time IS NOT NULL
       AND (exit_time AT TIME ZONE $2)::date = $3::date
       ${accountClause}`,
    params
  );
  return round2(num(result.rows[0]?.realized) ?? 0) ?? 0;
}

/**
 * Symbols with at least one still-open lot entered before shareDate (overnight holds).
 */
async function symbolsWithOvernightOpenLots(userId, shareDate, timezone) {
  const tz = timezone || 'UTC';
  const excluded = await BrokerConnection.getExcludedAccountIdentifiers(userId).catch(() => []);
  const params = [userId, tz, shareDate];
  let accountClause = '';
  if (excluded.length > 0) {
    params.push(excluded);
    accountClause = ` AND (account_identifier IS NULL OR account_identifier = '' OR account_identifier <> ALL($4::text[]))`;
  }
  const result = await db.query(
    `SELECT DISTINCT UPPER(symbol) AS symbol
     FROM trades
     WHERE user_id = $1
       AND exit_time IS NULL
       AND exit_price IS NULL
       AND (entry_time AT TIME ZONE $2)::date < $3::date
       ${accountClause}`,
    params
  );
  return new Set(result.rows.map((r) => r.symbol).filter(Boolean));
}

/**
 * Open day P/L from Schwab positions (TOS-shaped):
 * - Lots opened today → unrealized from average price (day P/L ≈ open P/L)
 * - Overnight holds → Schwab currentDayProfitLoss (vs prior close)
 */
function openDayPlFromSchwabPositions(accountsPayload, excludedLast4s, overnightSymbols) {
  let openDayPl = 0;
  let sawAny = false;

  for (const row of accountsPayload || []) {
    const sec = row.securitiesAccount || row;
    const accountNumber = sec?.accountNumber;
    const last4 = accountNumber ? String(accountNumber).slice(-4) : null;
    const masked = last4 ? `****${last4}` : null;
    if (!masked || schwabService.isSchwabAccountExcluded(masked, excludedLast4s)) continue;

    for (const position of sec.positions || []) {
      const assetType = position.instrument?.assetType;
      if (assetType === 'FUTURE' || assetType === 'FUTURE_OPTION' || assetType === 'CURRENCY') {
        continue;
      }
      const symbol = String(position.instrument?.symbol || '').toUpperCase();
      if (!symbol) continue;

      const longQty = num(position.longQuantity) || 0;
      const shortQty = num(position.shortQuantity) || 0;
      const qty = longQty - shortQty;
      if (!qty) continue;

      const dayPl = num(position.currentDayProfitLoss);
      const avg = num(position.averagePrice);
      const mv = num(position.marketValue);
      let uplFromAvg = null;
      if (avg != null && mv != null) {
        // marketValue is signed for shorts on Schwab; cost uses absolute qty.
        uplFromAvg = round2(mv - avg * qty);
      }

      const isOvernight = overnightSymbols.has(symbol);
      const contribution = isOvernight
        ? (dayPl != null ? dayPl : uplFromAvg)
        : (uplFromAvg != null ? uplFromAvg : dayPl);

      if (contribution == null) continue;
      openDayPl += contribution;
      sawAny = true;
    }
  }

  return sawAny ? round2(openDayPl) : null;
}

/**
 * P/L Day for the account strip = journal realized for the day.
 * Must match the Daily review "Day P&L" card (closed-trade contributions).
 * Open / day-mark P&L belongs on P/L Open, not here.
 */
async function computeTradingDayPl(userId, shareDate, {
  timezone,
  accessToken,
  accountsPayload = null,
  excludedLast4s = []
} = {}) {
  const { getUserTimezone } = require('../utils/timezone');
  const tz = timezone || await getUserTimezone(userId);
  const realizedPl = await sumRealizedPlForDay(userId, shareDate, tz);

  // Still compute open-day marks for diagnostics / future use, but do not
  // fold them into dayPl — that double-counted vs the Day P&L summary card.
  let openDayPl = null;
  try {
    let payload = accountsPayload;
    if (!payload && accessToken) {
      payload = await schwabService.getAccounts(accessToken, { fields: 'positions' });
    }
    if (payload) {
      const overnightSymbols = await symbolsWithOvernightOpenLots(userId, shareDate, tz);
      openDayPl = openDayPlFromSchwabPositions(payload, excludedLast4s, overnightSymbols);
    }
  } catch (error) {
    console.warn('[ACCOUNT-BALANCE] Open day P/L fetch failed:', error.message);
  }

  return { dayPl: realizedPl, realizedPl, openDayPl, timezone: tz };
}

/**
 * Live Schwab balances for a user (non-excluded accounts only).
 * @param {string} userId
 * @param {{ shareDate?: string }} [options] - YYYY-MM-DD for P/L Day; defaults to today UTC date
 */
async function fetchSchwabAccountStrip(userId, { shareDate } = {}) {
  const connections = await BrokerConnection.findByUserId(userId);
  const summary = connections.find(
    (c) => c.brokerType === 'schwab' && c.connectionStatus === 'active'
  );
  if (!summary) return null;

  // Need decrypted tokens for the API call.
  const schwabConn = await BrokerConnection.findById(summary.id, true);
  if (!schwabConn) return null;

  const { accessToken, needsReauth } = await schwabService.ensureValidToken(schwabConn);
  if (needsReauth || !accessToken) {
    console.warn('[ACCOUNT-BALANCE] Schwab token needs reauth; cannot fetch balances');
    return null;
  }

  // positions needed for open day P/L; balances are on the same payload.
  const payload = await schwabService.getAccounts(accessToken, { fields: 'positions' });
  const excluded = schwabService.getExcludedSchwabAccountLast4s(schwabConn);
  const parsed = [];

  for (const row of payload || []) {
    const account = parseSchwabAccount(row);
    if (!account.account) continue;
    if (schwabService.isSchwabAccountExcluded(account.account, excluded)) continue;
    parsed.push(account);
  }

  if (!parsed.length) return null;

  const strip = sumAccounts(parsed);
  strip.source = 'schwab';
  strip.fetchedAt = new Date().toISOString();
  // Denominator for "% of equity": prefer start-of-day Net Liq (closer to
  // "when opened" for same-day trades), else current.
  strip.equityForPct = strip.sodNetLiq ?? strip.netLiq;

  const dayKey = shareDate || new Date().toISOString().slice(0, 10);
  try {
    const trading = await computeTradingDayPl(userId, dayKey, {
      accountsPayload: payload,
      excludedLast4s: excluded
    });
    strip.dayPl = trading.dayPl;
    strip.realizedPl = trading.realizedPl;
    strip.openDayPl = trading.openDayPl;
    // Back-compat for any client still reading dayPlApprox.
    strip.dayPlApprox = trading.dayPl;
  } catch (error) {
    console.warn('[ACCOUNT-BALANCE] Trading day P/L failed:', error.message);
  }

  try {
    const heat = await computeOpenHeat(userId, {
      accessToken,
      excludedLast4s: excluded
    });
    strip.openHeat = heat.openHeat;
    strip.openHeatPositions = heat.positions;
    const equity = strip.equityForPct ?? strip.netLiq;
    strip.openHeatPct = (heat.openHeat != null && equity != null && equity > 0)
      ? round2((heat.openHeat / equity) * 100)
      : null;
  } catch (error) {
    console.warn('[ACCOUNT-BALANCE] Open heat failed:', error.message);
  }

  return strip;
}

/**
 * Persist equity into user_settings + equity_snapshots for the share date.
 */
async function persistEquitySnapshot(userId, shareDate, equityAmount) {
  if (equityAmount == null || !Number.isFinite(Number(equityAmount))) return;

  await db.query(
    `UPDATE user_settings SET account_equity = $2 WHERE user_id = $1`,
    [userId, equityAmount]
  ).catch(() => {});

  await db.query(
    `INSERT INTO equity_snapshots (user_id, snapshot_date, equity_amount)
     VALUES ($1, $2::date, $3)
     ON CONFLICT (user_id, snapshot_date)
     DO UPDATE SET equity_amount = EXCLUDED.equity_amount`,
    [userId, shareDate, equityAmount]
  ).catch((error) => {
    console.warn('[ACCOUNT-BALANCE] Failed to upsert equity_snapshots:', error.message);
  });
}

/**
 * Resolve equity denominator for a day: live Schwab strip, else snapshot row,
 * else user_settings.account_equity.
 */
async function resolveEquityForDay(userId, shareDate, { preferLive = false } = {}) {
  if (preferLive) {
    const live = await fetchSchwabAccountStrip(userId, { shareDate }).catch((error) => {
      console.warn('[ACCOUNT-BALANCE] Live fetch failed:', error.message);
      return null;
    });
    if (live?.equityForPct != null) return { equity: live.equityForPct, strip: live };
  }

  try {
    const snap = await db.query(
      `SELECT equity_amount FROM equity_snapshots
       WHERE user_id = $1 AND snapshot_date = $2::date`,
      [userId, shareDate]
    );
    if (snap.rows[0]?.equity_amount != null) {
      return { equity: Number(snap.rows[0].equity_amount), strip: null };
    }
  } catch (_) { /* table may be missing in odd envs */ }

  try {
    const settings = await db.query(
      `SELECT account_equity FROM user_settings WHERE user_id = $1`,
      [userId]
    );
    const equity = num(settings.rows[0]?.account_equity);
    if (equity != null && equity > 0) return { equity, strip: null };
  } catch (_) { /* ignore */ }

  return { equity: null, strip: null };
}

const DEFAULT_HEAT_FLOOR = 1500;

/**
 * Quote lookup key for Schwab market data (futures need a leading /).
 */
function schwabQuoteSymbol(symbol, instrumentType) {
  const raw = String(symbol || '').toUpperCase();
  if (!raw) return null;
  if (raw.startsWith('/')) return raw;
  const type = String(instrumentType || '').toLowerCase();
  if (type === 'future' || /^[A-Z]{1,5}[FGHJKMNQUVXZ]\d{1,2}$/.test(raw)) {
    return `/${raw}`;
  }
  return raw;
}

function positionMultiplier(tradeLike) {
  const instrumentType = String(tradeLike.instrument_type || tradeLike.instrumentType || 'stock').toLowerCase();
  if (instrumentType === 'future') {
    let pointValue = num(tradeLike.point_value ?? tradeLike.pointValue);
    if (pointValue == null || pointValue <= 0) {
      const root = tradeLike.underlying_asset
        || tradeLike.underlyingAsset
        || extractUnderlyingFromFuturesSymbol(tradeLike.symbol);
      pointValue = getFuturesPointValue(root);
    }
    return pointValue > 0 ? pointValue : 1;
  }
  if (instrumentType === 'option') {
    const contractSize = num(tradeLike.contract_size ?? tradeLike.contractSize);
    return contractSize > 0 ? contractSize : 100;
  }
  return 1;
}

/**
 * Dollars of adverse move from mark to stop for a side.
 */
function heatToStop(side, mark, stopPrice, qty, multiplier) {
  if (mark == null || stopPrice == null || !qty) return null;
  const mult = multiplier > 0 ? multiplier : 1;
  const isLong = String(side).toLowerCase() === 'long';
  const dollars = isLong
    ? (mark - stopPrice) * qty * mult
    : (stopPrice - mark) * qty * mult;
  return round2(Math.max(0, dollars));
}

function defaultHeatForPosition(openProfit) {
  const halfProfit = Math.max(0, Number(openProfit) || 0) / 2;
  return round2(Math.max(DEFAULT_HEAT_FLOOR, halfProfit));
}

/**
 * Aggregate open journal lots by symbol+side for heat sizing.
 */
async function loadOpenPositionLots(userId) {
  const excluded = await BrokerConnection.getExcludedAccountIdentifiers(userId).catch(() => []);
  const params = [userId];
  let accountClause = '';
  if (excluded.length > 0) {
    params.push(excluded);
    accountClause = ` AND (account_identifier IS NULL OR account_identifier = '' OR account_identifier <> ALL($2::text[]))`;
  }

  const result = await db.query(
    `SELECT
       UPPER(symbol) AS symbol,
       LOWER(side) AS side,
       MAX(instrument_type) AS instrument_type,
       MAX(point_value) AS point_value,
       MAX(underlying_asset) AS underlying_asset,
       MAX(contract_size) AS contract_size,
       SUM(quantity::float) AS quantity,
       SUM(quantity::float * entry_price::float) / NULLIF(SUM(quantity::float), 0) AS entry_price,
       MAX(stop_loss) FILTER (WHERE stop_loss IS NOT NULL) AS stop_loss
     FROM trades
     WHERE user_id = $1
       AND exit_time IS NULL
       AND exit_price IS NULL
       ${accountClause}
     GROUP BY UPPER(symbol), LOWER(side)
     ORDER BY UPPER(symbol)`,
    params
  );
  return result.rows;
}

/**
 * Open heat = $ risk from mark to stop across open positions.
 * Per position: Schwab WORKING stop → journal stop_loss → max($1500, half open profit).
 *
 * @returns {{ openHeat: number|null, positions: object[] }}
 */
async function computeOpenHeat(userId, {
  accessToken,
  excludedLast4s = []
} = {}) {
  const lots = await loadOpenPositionLots(userId);
  if (!lots.length) {
    return { openHeat: 0, positions: [] };
  }

  let stops = [];
  if (accessToken) {
    try {
      stops = await schwabService.getWorkingStopOrders(accessToken, { excludedLast4s });
    } catch (error) {
      console.warn('[ACCOUNT-BALANCE] Working stop orders failed:', error.message);
    }
  }

  const quoteSymbols = [...new Set(
    lots.map((lot) => schwabQuoteSymbol(lot.symbol, lot.instrument_type)).filter(Boolean)
  )];

  let quotes = {};
  try {
    const schwabMarketData = require('../utils/schwabMarketData');
    quotes = await schwabMarketData.getQuotes(quoteSymbols, { userId });
  } catch (error) {
    console.warn('[ACCOUNT-BALANCE] Open-heat quotes failed:', error.message);
  }

  const positions = [];
  let totalHeat = 0;

  for (const lot of lots) {
    const symbol = String(lot.symbol || '').toUpperCase();
    const side = String(lot.side || '').toLowerCase();
    const qty = num(lot.quantity) || 0;
    if (!symbol || !qty) continue;

    const multiplier = positionMultiplier(lot);
    const entry = num(lot.entry_price);
    const quoteKey = schwabQuoteSymbol(symbol, lot.instrument_type);
    const mark = num(quotes[quoteKey]?.c)
      ?? num(quotes[symbol]?.c)
      ?? num(quotes[quoteKey]?.lastPrice)
      ?? null;

    const signedQty = side === 'short' ? -qty : qty;
    const openProfit = (mark != null && entry != null)
      ? round2((mark - entry) * signedQty * multiplier)
      : null;

    const wantInstruction = side === 'long' ? 'SELL' : 'BUY';
    const matchedStops = stops.filter((s) => {
      if (s.symbol !== symbol) return false;
      const instr = String(s.instruction || '');
      // BUY_TO_COVER / SELL_SHORT etc. still contain BUY / SELL.
      return instr.includes(wantInstruction);
    });

    const stopQtyTotal = matchedStops.reduce((sum, s) => sum + (Number(s.quantity) || 0), 0);
    let schwabStopPx = null;
    if (stopQtyTotal > 0) {
      schwabStopPx = matchedStops.reduce(
        (sum, s) => sum + Number(s.stopPrice) * (Number(s.quantity) || 0),
        0
      ) / stopQtyTotal;
    }

    // Treat 0 / non-positive as "no stop" (DB defaults and empty fields).
    const journalStop = num(lot.stop_loss);
    const usableJournalStop = journalStop != null && journalStop > 0 ? journalStop : null;
    const stopPrice = schwabStopPx ?? usableJournalStop;
    const coveredQty = stopPrice != null
      ? Math.min(qty, stopQtyTotal > 0 ? stopQtyTotal : qty)
      : 0;
    const uncoveredQty = round2(qty - coveredQty) ?? (qty - coveredQty);

    let heat = 0;
    let source = 'default';
    const parts = [];
    let appliedStopHeat = false;

    if (coveredQty > 0 && stopPrice != null && mark != null) {
      const stopHeat = heatToStop(side, mark, stopPrice, coveredQty, multiplier);
      if (stopHeat != null) {
        heat += stopHeat;
        appliedStopHeat = true;
        source = schwabStopPx != null ? 'schwab_stop' : 'journal_stop';
        parts.push({ kind: source, qty: coveredQty, stopPrice: round2(stopPrice), heat: stopHeat });
      }
    }

    // Unprotected size, or stop present but unusable without a mark → per-position default.
    const defaultQty = appliedStopHeat
      ? (uncoveredQty > 0.0001 ? uncoveredQty : 0)
      : qty;

    if (defaultQty > 0.0001) {
      const defaultProfit = (openProfit != null && qty > 0)
        ? openProfit * (defaultQty / qty)
        : openProfit;
      const defHeat = defaultHeatForPosition(defaultProfit);
      heat += defHeat;
      source = appliedStopHeat ? `${source}+default` : 'default';
      parts.push({ kind: 'default', qty: defaultQty, heat: defHeat });
    }

    heat = round2(heat) ?? 0;
    totalHeat += heat;

    positions.push({
      symbol,
      side,
      quantity: round2(qty),
      entryPrice: entry != null ? round2(entry) : null,
      mark: mark != null ? round2(mark) : null,
      stopPrice: stopPrice != null ? round2(stopPrice) : null,
      openProfit,
      heat,
      heatSource: source,
      parts
    });
  }

  return {
    openHeat: round2(totalHeat),
    positions
  };
}

/**
 * Capture live Schwab strip for a share day and persist it.
 */
async function captureAccountSnapshotForDay(userId, shareDate) {
  const strip = await fetchSchwabAccountStrip(userId, { shareDate });
  if (!strip) return null;

  await persistEquitySnapshot(userId, shareDate, strip.equityForPct ?? strip.netLiq);
  return strip;
}

/**
 * Position notional in account currency (futures use point value).
 */
function tradeNotional(trade) {
  const entry = num(trade.entry_price ?? trade.entryPrice);
  const qty = num(trade.quantity);
  if (entry == null || qty == null) return null;

  const instrumentType = String(trade.instrument_type || trade.instrumentType || 'stock').toLowerCase();
  let multiplier = 1;

  if (instrumentType === 'future') {
    let pointValue = num(trade.point_value ?? trade.pointValue);
    if (pointValue == null || pointValue <= 0) {
      const root = trade.underlying_asset
        || trade.underlyingAsset
        || extractUnderlyingFromFuturesSymbol(trade.symbol);
      pointValue = getFuturesPointValue(root);
    }
    multiplier = pointValue > 0 ? pointValue : 1;
  } else if (instrumentType === 'option') {
    const contractSize = num(trade.contract_size ?? trade.contractSize);
    multiplier = contractSize > 0 ? contractSize : 100;
  }

  return round2(Math.abs(entry * qty * multiplier));
}

function equityPercents(notional, pnl, equity) {
  if (equity == null || equity <= 0) {
    return { equity_used_pct: null, equity_pnl_pct: null };
  }
  return {
    equity_used_pct: notional != null ? round2((notional / equity) * 100) : null,
    equity_pnl_pct: pnl != null ? round2((Number(pnl) / equity) * 100) : null
  };
}

module.exports = {
  parseSchwabAccount,
  fetchSchwabAccountStrip,
  captureAccountSnapshotForDay,
  resolveEquityForDay,
  persistEquitySnapshot,
  computeTradingDayPl,
  openDayPlFromSchwabPositions,
  computeOpenHeat,
  heatToStop,
  defaultHeatForPosition,
  tradeNotional,
  equityPercents,
  round2,
  DEFAULT_HEAT_FLOOR
};
