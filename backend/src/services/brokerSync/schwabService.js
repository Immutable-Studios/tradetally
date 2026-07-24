/**
 * Schwab API Integration Service
 * Fetches trade data from Charles Schwab using their Developer API
 *
 * API Documentation: https://developer.schwab.com
 *
 * Note: Schwab requires:
 * 1. Developer account registration at developer.schwab.com
 * 2. App approval (can take a few days)
 * 3. Think or Swim enabled account
 * 4. Manual re-authentication every 7 days (refresh token limitation)
 */

const axios = require('axios');
const Trade = require('../../models/Trade');
const BrokerConnection = require('../../models/BrokerConnection');
const AnalyticsCache = require('../analyticsCache');
const OptionStrategyGroupingService = require('../optionStrategyGroupingService');
const db = require('../../config/database');
const {
  extractUnderlyingFromFuturesSymbol,
  getFuturesPointValue,
  parseFuturesContractFields,
  isFuturesContractExpired
} = require('../../utils/futuresUtils');

const SCHWAB_API_BASE = 'https://api.schwabapi.com/trader/v1';
const TOKEN_REFRESH_BUFFER = 5 * 60 * 1000; // Refresh 5 minutes before expiration
const SCHWAB_TRADEABLE_ASSET_TYPES = [
  'EQUITY',
  'OPTION',
  'MUTUAL_FUND',
  'ETF',
  'INDEX',
  'FUTURE',
  'COLLECTIVE_INVESTMENT'
];
// Schwab /transactions silently truncates each request around this size.
const SCHWAB_TX_PAGE_LIMIT = 3000;

class SchwabService {
  /**
   * Redact account number for privacy - show only last 4 characters
   * @param {string} accountNumber - Full account number
   * @returns {string} - Redacted account number (e.g., "****1234")
   */
  redactAccountNumber(accountNumber) {
    if (!accountNumber) return null;
    const str = String(accountNumber);
    if (str.length <= 4) return str;
    return '****' + str.slice(-4);
  }

  /**
   * Last-4 digits used to match excluded Schwab accounts (full or redacted).
   * Stored on connection.brokerMetadata.excludedSchwabAccounts as e.g. ["****7790"] or ["7790"].
   */
  _accountLast4(accountNumberOrRedacted) {
    if (!accountNumberOrRedacted) return null;
    const digits = String(accountNumberOrRedacted).replace(/\D/g, '');
    if (!digits) return null;
    return digits.slice(-4);
  }

  /**
   * @param {object} connection - BrokerConnection (brokerMetadata optional)
   * @returns {string[]} last-4 digit codes for excluded accounts
   */
  getExcludedSchwabAccountLast4s(connection) {
    const raw = connection?.brokerMetadata?.excludedSchwabAccounts
      || connection?.broker_metadata?.excludedSchwabAccounts
      || [];
    if (!Array.isArray(raw)) return [];
    return raw
      .map(v => this._accountLast4(v))
      .filter(Boolean);
  }

  isSchwabAccountExcluded(accountNumberOrRedacted, excludedLast4s) {
    if (!excludedLast4s?.length) return false;
    const last4 = this._accountLast4(accountNumberOrRedacted);
    return Boolean(last4 && excludedLast4s.includes(last4));
  }

  /**
   * Extract date string (YYYY-MM-DD) from various date formats
   * Handles Date objects, ISO strings, date-only strings, and edge cases
   * @param {Date|string|any} dateValue - The date value to extract from
   * @returns {string|null} - Date string in YYYY-MM-DD format, or null if invalid
   */
  _extractDateString(dateValue) {
    if (!dateValue) return null;

    // Handle Date objects
    if (dateValue instanceof Date) {
      return dateValue.toISOString().split('T')[0];
    }

    // Convert to string and handle various formats
    const str = String(dateValue);

    // ISO format: 2025-01-30T10:00:00Z
    if (str.includes('T')) {
      return str.split('T')[0];
    }

    // Date-only format: 2025-01-30
    if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
      return str.slice(0, 10);
    }

    // Try to parse as date
    const parsed = new Date(str);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString().split('T')[0];
    }

    return null;
  }

  /**
   * Schwab transactions can include both `time` and `tradeDate`. Some responses
   * only provide a date-like `tradeDate`, which is not precise enough for FIFO
   * matching intraday partial exits. Prefer whichever field contains an actual
   * intraday time so buys and sells are processed in execution order.
   */
  _getTransactionTime(tx) {
    const candidates = [tx.time, tx.tradeDate].filter(Boolean);
    const precise = candidates.find(value => this._hasIntradayTime(value));
    return precise || candidates[0] || null;
  }

  _hasIntradayTime(value) {
    if (!value) return false;

    if (value instanceof Date) {
      return value.getUTCHours() !== 0 ||
        value.getUTCMinutes() !== 0 ||
        value.getUTCSeconds() !== 0 ||
        value.getUTCMilliseconds() !== 0;
    }

    const str = String(value);
    const match = str.match(/T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
    if (!match) return false;

    const [, hours, minutes, seconds, milliseconds = '0'] = match;
    return Number(hours) !== 0 ||
      Number(minutes) !== 0 ||
      Number(seconds) !== 0 ||
      Number(milliseconds) !== 0;
  }

  _getTimeValue(value) {
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : null;
  }

  _compareTransactionsForMatching(a, b) {
    const aTime = this._getTimeValue(a.time);
    const bTime = this._getTimeValue(b.time);

    if (aTime !== null && bTime !== null && aTime !== bTime) {
      return aTime - bTime;
    }

    if (aTime !== null && bTime === null) return -1;
    if (aTime === null && bTime !== null) return 1;

    // If Schwab only gave date-level timestamps, process openings before
    // closings so same-day scale-outs are not treated as unmatched short sales.
    const effectRank = { OPENING: 0, CLOSING: 1 };
    const aRank = effectRank[a.positionEffect] ?? 2;
    const bRank = effectRank[b.positionEffect] ?? 2;
    if (aRank !== bRank) {
      return aRank - bRank;
    }

    return String(a.orderId || '').localeCompare(String(b.orderId || ''));
  }

  _parseSchwabOptionSymbol(symbol) {
    if (!symbol) return null;

    const normalized = String(symbol).toUpperCase().replace(/\s+/g, ' ').trim();
    const compact = normalized.replace(/\s+/g, '');
    const match = normalized.match(/^([A-Z]{1,6})\s+(\d{6})([CP])(\d{8})$/) ||
      compact.match(/^([A-Z]{1,6})(\d{6})([CP])(\d{8})$/);

    if (!match) return null;

    const [, underlyingSymbol, expiry, type, strike] = match;
    const year = 2000 + parseInt(expiry.slice(0, 2), 10);
    const month = parseInt(expiry.slice(2, 4), 10);
    const day = parseInt(expiry.slice(4, 6), 10);

    if (month < 1 || month > 12 || day < 1 || day > 31) {
      return null;
    }

    return {
      underlyingSymbol,
      expirationDate: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      optionType: type === 'C' ? 'call' : 'put',
      strikePrice: parseInt(strike, 10) / 1000,
      contractSize: 100
    };
  }

  /**
   * Check if tokens need refresh and refresh if necessary
   * @param {object} connection - BrokerConnection with credentials
   * @returns {Promise<{accessToken: string, needsReauth: boolean}>}
   */
  async ensureValidToken(connection) {
    // Handle missing or invalid expiration date
    if (!connection.schwabTokenExpiresAt) {
      console.log('[SCHWAB] No token expiration date, attempting refresh...');
      try {
        const newTokens = await this.refreshAccessToken(connection.schwabRefreshToken);
        await BrokerConnection.updateSchwabTokens(
          connection.id,
          newTokens.accessToken,
          newTokens.refreshToken,
          newTokens.expiresAt
        );
        return { accessToken: newTokens.accessToken, needsReauth: false };
      } catch (error) {
        console.error('[SCHWAB] Token refresh failed:', error.message);
        await BrokerConnection.updateStatus(connection.id, 'expired', 'Refresh token expired - please re-authenticate');
        return { accessToken: null, needsReauth: true };
      }
    }

    const expiresAt = new Date(connection.schwabTokenExpiresAt);
    const now = new Date();

    // Check if expiration date is invalid
    if (isNaN(expiresAt.getTime())) {
      console.log('[SCHWAB] Invalid token expiration date, attempting refresh...');
      try {
        const newTokens = await this.refreshAccessToken(connection.schwabRefreshToken);
        await BrokerConnection.updateSchwabTokens(
          connection.id,
          newTokens.accessToken,
          newTokens.refreshToken,
          newTokens.expiresAt
        );
        return { accessToken: newTokens.accessToken, needsReauth: false };
      } catch (error) {
        console.error('[SCHWAB] Token refresh failed:', error.message);
        await BrokerConnection.updateStatus(connection.id, 'expired', 'Refresh token expired - please re-authenticate');
        return { accessToken: null, needsReauth: true };
      }
    }

    // Check if token is expired or about to expire
    if (expiresAt.getTime() - now.getTime() < TOKEN_REFRESH_BUFFER) {
      console.log('[SCHWAB] Token expired or expiring soon, refreshing...');

      try {
        const newTokens = await this.refreshAccessToken(connection.schwabRefreshToken);

        // Update connection with new tokens
        await BrokerConnection.updateSchwabTokens(
          connection.id,
          newTokens.accessToken,
          newTokens.refreshToken,
          newTokens.expiresAt
        );

        return { accessToken: newTokens.accessToken, needsReauth: false };
      } catch (error) {
        // Refresh token likely expired (7 day limit)
        console.error('[SCHWAB] Token refresh failed:', error.message);
        await BrokerConnection.updateStatus(connection.id, 'expired', 'Refresh token expired - please re-authenticate');
        return { accessToken: null, needsReauth: true };
      }
    }

    return { accessToken: connection.schwabAccessToken, needsReauth: false };
  }

  /**
   * Refresh the access token using the refresh token
   * @param {string} refreshToken - Current refresh token
   * @returns {Promise<{accessToken: string, refreshToken: string, expiresAt: Date}>}
   */
  async refreshAccessToken(refreshToken) {
    console.log('[SCHWAB] Refreshing access token...');

    const response = await axios.post(
      'https://api.schwabapi.com/v1/oauth/token',
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      }),
      {
        auth: {
          username: process.env.SCHWAB_CLIENT_ID,
          password: process.env.SCHWAB_CLIENT_SECRET
        },
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    const { access_token, refresh_token, expires_in } = response.data;
    const expiresAt = new Date(Date.now() + expires_in * 1000);

    console.log('[SCHWAB] Token refreshed successfully');

    return {
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt
    };
  }

  /**
   * Get encrypted account numbers (required for all account-specific API calls)
   * @param {string} accessToken - Valid access token
   * @returns {Promise<Array<{accountNumber: string, hashValue: string}>>}
   */
  async getAccountNumbers(accessToken) {
    console.log('[SCHWAB] Fetching encrypted account numbers...');

    const response = await axios.get(
      `${SCHWAB_API_BASE}/accounts/accountNumbers`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    console.log(`[SCHWAB] Found ${response.data?.length || 0} accounts`);
    return response.data || [];
  }

  /**
   * Get account information
   * @param {string} accessToken - Valid access token
   * @param {object} [options]
   * @param {string} [options.fields] - Optional Schwab fields param (e.g. 'positions')
   * @returns {Promise<object>}
   */
  async getAccounts(accessToken, { fields } = {}) {
    console.log('[SCHWAB] Fetching accounts...');

    const response = await axios.get(
      `${SCHWAB_API_BASE}/accounts`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        params: fields ? { fields } : undefined
      }
    );

    return response.data;
  }

  /**
   * Working / pending stop-like orders across non-excluded accounts.
   * Schwab requires fromEnteredTime/toEnteredTime (max 60-day window).
   *
   * @param {string} accessToken
   * @param {{ excludedLast4s?: string[] }} [options]
   * @returns {Promise<Array<{ symbol: string, instruction: string, quantity: number, stopPrice: number, orderType: string, status: string, account: string }>>}
   */
  async getWorkingStopOrders(accessToken, { excludedLast4s = [] } = {}) {
    const accounts = await this.getAccountNumbers(accessToken);
    const now = new Date();
    const from = new Date(now.getTime() - 59 * 24 * 60 * 60 * 1000);
    const statuses = ['WORKING', 'PENDING_ACTIVATION', 'AWAITING_STOP_CONDITION', 'QUEUED', 'ACCEPTED'];
    const stops = [];

    for (const account of accounts || []) {
      const last4 = this._accountLast4(account.accountNumber);
      if (last4 && excludedLast4s.includes(last4)) continue;

      for (const status of statuses) {
        try {
          const response = await axios.get(
            `${SCHWAB_API_BASE}/accounts/${account.hashValue}/orders`,
            {
              headers: { Authorization: `Bearer ${accessToken}` },
              params: {
                fromEnteredTime: from.toISOString(),
                toEnteredTime: now.toISOString(),
                status,
                maxResults: 100
              }
            }
          );

          for (const order of response.data || []) {
            const orderType = String(order.orderType || '');
            const stopPrice = Number(order.stopPrice);
            const isStopLike = /STOP|TRAIL/i.test(orderType) || Number.isFinite(stopPrice);
            if (!isStopLike || !Number.isFinite(stopPrice)) continue;

            const leg = (order.orderLegCollection || [])[0];
            const symbol = String(leg?.instrument?.symbol || '').toUpperCase();
            if (!symbol) continue;

            stops.push({
              symbol,
              instruction: String(leg?.instruction || '').toUpperCase(),
              quantity: Number(order.quantity) || Number(leg?.quantity) || 0,
              stopPrice,
              orderType,
              status: String(order.status || status),
              account: this.redactAccountNumber(account.accountNumber)
            });
          }
        } catch (error) {
          const code = error.response?.status;
          // Empty status filters often 400; skip quietly.
          if (code !== 400 && code !== 404) {
            console.warn(
              `[SCHWAB] Orders fetch failed for ****${last4} status=${status}:`,
              error.response?.data || error.message
            );
          }
        }
      }
    }

    return stops;
  }

  /**
   * Build account|symbol -> live equity position map from Schwab /accounts?fields=positions.
   * Used to drop phantom FIFO opens when broker inventory is flat/smaller.
   * @param {Array} accountsPayload - Schwab accounts response
   * @returns {Map<string, {symbol:string, accountIdentifier:string, quantity:number, side:string, averagePrice:number|null}>}
   */
  /**
   * Decide whether an accounts payload is a trustworthy picture of open positions.
   *
   * Schwab OMITS `positions` entirely when an account holds nothing, so a missing
   * field usually means "flat", not "data unavailable" -- treating it as
   * unavailable would stop us ever clearing phantoms from a flattened account.
   * The discriminator is market value: an account that omits positions while
   * reporting non-zero long/short market value is withholding data, and
   * reconciling against that would delete real positions.
   *
   * Excluded accounts are ignored -- we never reconcile them, so their payload
   * shape must not veto reconciling the accounts we do sync.
   *
   * @param {Array} accountsPayload
   * @param {string[]} excludedLast4s
   * @returns {{usable: boolean, flat: boolean, reason: string}}
   */
  assessBrokerPositions(accountsPayload, excludedLast4s = []) {
    const accounts = (accountsPayload || []).filter(account => {
      const redacted = this.redactAccountNumber(account?.securitiesAccount?.accountNumber);
      return !this.isSchwabAccountExcluded(redacted, excludedLast4s);
    });

    if (accounts.length === 0) {
      return { usable: false, flat: false, reason: 'no syncable accounts in positions payload' };
    }

    let anyPositionsField = false;
    const withheld = [];

    for (const account of accounts) {
      const securitiesAccount = account.securitiesAccount || {};
      if (Object.prototype.hasOwnProperty.call(securitiesAccount, 'positions')) {
        anyPositionsField = true;
        continue;
      }
      const balances = securitiesAccount.currentBalances || {};
      const longMarketValue = Number(balances.longMarketValue) || 0;
      const shortMarketValue = Number(balances.shortMarketValue) || 0;
      if (longMarketValue !== 0 || shortMarketValue !== 0) {
        withheld.push(this.redactAccountNumber(securitiesAccount.accountNumber));
      }
    }

    if (withheld.length > 0) {
      return {
        usable: false,
        flat: false,
        reason: `account(s) ${withheld.join(', ')} omitted positions while holding non-zero market value`
      };
    }

    return {
      usable: true,
      flat: !anyPositionsField,
      reason: anyPositionsField
        ? 'positions present'
        : 'all syncable accounts flat (zero long/short market value)'
    };
  }

  buildBrokerEquityPositionMap(accountsPayload, excludedLast4s = []) {
    const map = new Map();
    for (const account of accountsPayload || []) {
      const accountIdentifier = this.redactAccountNumber(account.securitiesAccount?.accountNumber);
      if (!accountIdentifier) continue;
      if (this.isSchwabAccountExcluded(accountIdentifier, excludedLast4s)) continue;

      for (const position of account.securitiesAccount?.positions || []) {
        const instrument = position.instrument || {};
        const symbol = instrument.symbol;
        if (!symbol || instrument.assetType === 'CURRENCY') continue;
        // Stocks + ETFs (Schwab types ETFs as COLLECTIVE_INVESTMENT). Skip options/futures.
        const assetType = instrument.assetType;
        const isEquityLike = !assetType
          || assetType === 'EQUITY'
          || assetType === 'COLLECTIVE_INVESTMENT';
        if (!isEquityLike) continue;

        const longQty = Number(position.longQuantity) || 0;
        const shortQty = Number(position.shortQuantity) || 0;
        const net = longQty - shortQty;
        if (net === 0) continue;

        const key = `${accountIdentifier}|${symbol}`;
        const existing = map.get(key);
        const quantity = Math.abs(net);
        const side = net > 0 ? 'long' : 'short';
        const averagePrice = position.averagePrice ?? position.averageLongPrice ?? position.averageShortPrice ?? null;

        if (existing) {
          // Same symbol listed twice — net the quantities
          const signed = (existing.side === 'long' ? existing.quantity : -existing.quantity)
            + (side === 'long' ? quantity : -quantity);
          if (signed === 0) {
            map.delete(key);
          } else {
            map.set(key, {
              symbol,
              accountIdentifier,
              quantity: Math.abs(signed),
              side: signed > 0 ? 'long' : 'short',
              averagePrice: averagePrice ?? existing.averagePrice
            });
          }
        } else {
          map.set(key, { symbol, accountIdentifier, quantity, side, averagePrice });
        }
      }
    }
    return map;
  }

  /**
   * Drop / trim equity open trades that exceed live Schwab positions.
   * TRADE history alone misses journals/corp-actions, which leaves false opens
   * (e.g. ETHU flat at Schwab but leftover lots in the journal).
   *
   * @param {Array} trades - Parsed trades from match/group
   * @param {Map} brokerPositions - from buildBrokerEquityPositionMap (empty Map = flat book)
   * @returns {Array} reconciled trades
   */
  reconcileOpenTradesWithBrokerPositions(trades, brokerPositions) {
    const positionMap = brokerPositions || new Map();
    const closedOrNonEquity = [];
    const opensByKey = new Map();

    for (const trade of trades) {
      const isOpen = trade.exitPrice == null && trade.exitTime == null;
      const isEquity = !trade.instrumentType || trade.instrumentType === 'stock';
      if (!isOpen || !isEquity) {
        closedOrNonEquity.push(trade);
        continue;
      }
      const key = `${trade.accountIdentifier || 'unknown'}|${trade.symbol}`;
      if (!opensByKey.has(key)) opensByKey.set(key, []);
      opensByKey.get(key).push(trade);
    }

    const reconciledOpens = [];

    for (const [key, opens] of opensByKey.entries()) {
      opens.sort((a, b) => new Date(a.entryTime || 0) - new Date(b.entryTime || 0));
      const journalQty = opens.reduce((sum, t) => sum + (Number(t.quantity) || 0), 0);
      const broker = positionMap.get(key);
      const brokerQty = broker ? Number(broker.quantity) || 0 : 0;

      if (broker && broker.side !== opens[0].side) {
        console.warn(`[SCHWAB] Position side mismatch for ${key}: journal=${opens[0].side} broker=${broker.side} — keeping matcher opens`);
        reconciledOpens.push(...opens);
        continue;
      }

      if (journalQty <= brokerQty) {
        reconciledOpens.push(...opens);
        if (brokerQty > journalQty) {
          console.warn(`[SCHWAB] Broker holds more than FIFO opens for ${key}: journal=${journalQty} broker=${brokerQty}`);
        }
        continue;
      }

      let excess = journalQty - brokerQty;
      console.log(`[SCHWAB] Reconciling phantom opens for ${key}: journal=${journalQty} broker=${brokerQty} dropping=${excess}`);
      for (const trade of opens) {
        if (excess <= 0) {
          reconciledOpens.push(trade);
          continue;
        }
        const qty = Number(trade.quantity) || 0;
        if (qty <= excess) {
          excess -= qty;
          continue;
        }
        const keepQty = qty - excess;
        excess = 0;
        reconciledOpens.push(this._resizeOpenTrade(trade, keepQty));
      }
    }

    for (const [key, broker] of positionMap.entries()) {
      if (!opensByKey.has(key)) {
        console.warn(`[SCHWAB] Broker open not reconstructed by FIFO for ${key}: qty=${broker.quantity}`);
      }
    }

    return [...closedOrNonEquity, ...reconciledOpens];
  }

  _resizeOpenTrade(trade, keepQty) {
    const resized = {
      ...trade,
      quantity: keepQty,
      executionData: (trade.executionData || []).map(exec => (
        exec.type === 'entry'
          ? { ...exec, quantity: keepQty }
          : exec
      ))
    };
    if (resized.commission != null && trade.quantity > 0) {
      resized.commission = Math.round((trade.commission * keepQty / trade.quantity) * 100) / 100;
    }
    if (resized.fees != null && trade.quantity > 0) {
      resized.fees = Math.round((trade.fees * keepQty / trade.quantity) * 100) / 100;
    }
    return resized;
  }



  /**
   * Repair ALREADY-PERSISTED open equity rows against live broker inventory.
   *
   * reconcileOpenTradesWithBrokerPositions only filters the trade list produced
   * by the current parse, so phantom opens written by earlier syncs survive in
   * the database forever (a re-sync just reports them as duplicates). This
   * trims persisted open lots down to what the broker actually holds.
   *
   * Only accounts in `syncedAccountIdentifiers` are touched — we have no
   * authoritative position data for excluded accounts, so their rows are left
   * alone rather than being deleted as false phantoms.
   *
   * @param {string} userId
   * @param {string} connectionId
   * @param {Map} brokerPositions - from buildBrokerEquityPositionMap
   * @param {string[]} syncedAccountIdentifiers - redacted ids actually synced
   * @param {{ dryRun?: boolean }} [options]
   */
  async reconcilePersistedOpenEquity(userId, connectionId, brokerPositions, syncedAccountIdentifiers, { dryRun = false, allowEmpty = false } = {}) {
    const positionMap = brokerPositions || new Map();
    const syncedAccounts = new Set(syncedAccountIdentifiers || []);
    const summary = { deleted: [], resized: [], keptLots: 0, skippedAccounts: new Set() };

    // Independent safety net (the caller also checks brokerPositionsAvailable):
    // an empty map would mark every persisted open as phantom and delete the
    // whole book. A truly flat account is far rarer than a bad/partial API
    // response, so refuse rather than risk destroying real positions.
    if (positionMap.size === 0 && !allowEmpty) {
      console.warn('[SCHWAB] Skipping persisted open reconcile: empty position map not confirmed flat (refusing to delete every open lot)');
      return summary;
    }

    const { rows } = await db.query(
      `SELECT id, symbol, side, quantity, entry_time, account_identifier
       FROM trades
       WHERE user_id = $1 AND broker_connection_id = $2
         AND exit_price IS NULL AND exit_time IS NULL
         AND (instrument_type IS NULL OR instrument_type = 'stock')
       ORDER BY entry_time ASC NULLS FIRST`,
      [userId, connectionId]
    );

    const groups = new Map();
    for (const row of rows) {
      const account = row.account_identifier || 'unknown';
      if (!syncedAccounts.has(account)) {
        summary.skippedAccounts.add(account);
        continue;
      }
      const key = `${account}|${row.symbol}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }

    for (const [key, lots] of groups.entries()) {
      const broker = positionMap.get(key);
      const brokerQty = broker ? Number(broker.quantity) || 0 : 0;
      const dbQty = lots.reduce((sum, l) => sum + (Number(l.quantity) || 0), 0);

      if (dbQty <= brokerQty) {
        summary.keptLots += lots.length;
        continue;
      }

      let excess = dbQty - brokerQty;
      console.log(`[SCHWAB] Persisted open reconcile ${key}: db=${dbQty} broker=${brokerQty} trimming=${excess}`);

      // Drop newest lots first so the earliest (original) entry survives.
      for (const lot of [...lots].reverse()) {
        if (excess <= 0) break;
        const qty = Number(lot.quantity) || 0;
        if (qty <= excess) {
          excess -= qty;
          summary.deleted.push({ key, id: lot.id, quantity: qty });
          if (!dryRun) await Trade.delete(lot.id, userId);
        } else {
          const keepQty = qty - excess;
          excess = 0;
          summary.resized.push({ key, id: lot.id, from: qty, to: keepQty });
          if (!dryRun) {
            await db.query(
              `UPDATE trades SET quantity = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
              [keepQty, lot.id]
            );
          }
        }
      }
    }

    summary.skippedAccounts = [...summary.skippedAccounts];
    return summary;
  }

  /**
   * Net signed position per account|symbol from parsed fills (API amount sign).
   * Used to drop false futures opens when FIFO is skewed by truncated history
   * or earlier orphan lots stealing closes.
   */
  buildFillNetPositionMap(parsedFills) {
    const map = new Map();
    for (const fill of parsedFills || []) {
      if (fill.instrumentType !== 'future') continue;
      const key = `${fill.accountIdentifier || 'unknown'}|${fill.matchingSymbol || fill.symbol}`;
      const delta = fill.signedQuantity != null ? Number(fill.signedQuantity) : 0;
      if (!Number.isFinite(delta) || delta === 0) continue;
      map.set(key, (map.get(key) || 0) + delta);
    }
    return map;
  }

  /**
   * Align futures open trades to the fill-stream net position.
   * Schwab's positions API often omits FUTURES, so equity broker-position
   * reconcile cannot clear these.
   */
  reconcileOpenFuturesWithFillNet(trades, parsedFills) {
    const fillNet = this.buildFillNetPositionMap(parsedFills);
    const kept = [];
    const opensByKey = new Map();

    for (const trade of trades || []) {
      const isOpen = trade.exitPrice == null && trade.exitTime == null;
      if (!isOpen || trade.instrumentType !== 'future') {
        kept.push(trade);
        continue;
      }
      const key = `${trade.accountIdentifier || 'unknown'}|${trade.matchingSymbol || trade.symbol}`;
      if (!opensByKey.has(key)) opensByKey.set(key, []);
      opensByKey.get(key).push(trade);
    }

    for (const [key, opens] of opensByKey.entries()) {
      const net = fillNet.get(key) || 0;
      const targetQty = Math.abs(net);
      const targetSide = net > 0 ? 'long' : net < 0 ? 'short' : null;

      if (!targetSide || targetQty === 0) {
        console.log(`[SCHWAB] Fill-net flat for futures ${key} — dropping ${opens.length} open lot(s)`);
        continue;
      }

      const sideOpens = opens
        .filter(o => o.side === targetSide)
        .sort((a, b) => new Date(a.entryTime || 0) - new Date(b.entryTime || 0));
      const droppedWrongSide = opens.length - sideOpens.length;
      if (droppedWrongSide > 0) {
        console.log(`[SCHWAB] Fill-net dropping ${droppedWrongSide} wrong-side open(s) for ${key}`);
      }

      let remaining = targetQty;
      const journalQty = sideOpens.reduce((s, t) => s + (Number(t.quantity) || 0), 0);
      if (journalQty > targetQty) {
        console.log(`[SCHWAB] Fill-net trimming futures opens for ${key}: journal=${journalQty} net=${net}`);
      }

      for (const trade of sideOpens) {
        if (remaining <= 0) break;
        const qty = Number(trade.quantity) || 0;
        if (qty <= remaining) {
          kept.push(trade);
          remaining -= qty;
        } else {
          kept.push(this._resizeOpenTrade(trade, remaining));
          remaining = 0;
        }
      }
    }

    return kept;
  }

  /**
   * Fetch TRADE transactions for [startDate, endDate], bisecting the range when
   * Schwab returns a full page (truncated). Without this, year-sized windows
   * quietly drop older fills and FIFO leaves false futures/stock opens.
   */
  async fetchTransactionsUncapped(accessToken, accountHash, startDate, endDate, depth = 0) {
    const response = await axios.get(
      `${SCHWAB_API_BASE}/accounts/${accountHash}/transactions`,
      {
        params: {
          types: 'TRADE',
          startDate: this.formatDateForApi(startDate),
          endDate: this.formatDateForApi(endDate, true)
        },
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    const data = response.data || [];
    if (data.length < SCHWAB_TX_PAGE_LIMIT) {
      return data;
    }

    if (startDate >= endDate) {
      console.warn(`[SCHWAB] Hit ${SCHWAB_TX_PAGE_LIMIT}-tx cap on single day ${startDate}; using truncated page`);
      return data;
    }

    const startMs = Date.parse(`${startDate}T00:00:00.000Z`);
    const endMs = Date.parse(`${endDate}T00:00:00.000Z`);
    const midMs = startMs + Math.floor((endMs - startMs) / 2);
    const midDate = new Date(midMs).toISOString().slice(0, 10);
    const nextMs = Date.parse(`${midDate}T00:00:00.000Z`) + 24 * 60 * 60 * 1000;
    const nextDate = new Date(nextMs).toISOString().slice(0, 10);

    if (midDate <= startDate || nextDate > endDate) {
      console.warn(`[SCHWAB] Hit ${SCHWAB_TX_PAGE_LIMIT}-tx cap for ${startDate}..${endDate} but cannot split further; using truncated page`);
      return data;
    }

    console.log(`[SCHWAB] Hit ${SCHWAB_TX_PAGE_LIMIT}-tx cap for ${startDate}..${endDate} — splitting at ${midDate}`);
    const left = await this.fetchTransactionsUncapped(accessToken, accountHash, startDate, midDate, depth + 1);
    const right = await this.fetchTransactionsUncapped(accessToken, accountHash, nextDate, endDate, depth + 1);
    return left.concat(right);
  }

  /**
   * Get transactions for an account
   * Fetches year by year going backwards until 2 consecutive empty years or 25 years max
   * @param {string} accessToken - Valid access token
   * @param {string} accountHash - Encrypted account hash value
   * @param {string} startDate - Start date (YYYY-MM-DD format) - if provided, uses fixed range
   * @param {string} endDate - End date (YYYY-MM-DD format)
   * @returns {Promise<Array>}
   */
  async getTransactions(accessToken, accountHash, startDate, endDate) {
    console.log(`[SCHWAB] Account hash: ${accountHash?.substring(0, 10)}...`);

    // If specific date range provided, use that with chunking
    if (startDate) {
      return this.getTransactionsForRange(accessToken, accountHash, startDate, endDate);
    }

    // Otherwise, fetch all history by going backwards year by year
    return this.getTransactionsAllHistory(accessToken, accountHash);
  }

  /**
   * Fetch all transaction history by going backwards year by year
   * Stops after 2 consecutive years with no data or 25 years max
   */
  async getTransactionsAllHistory(accessToken, accountHash) {
    const allTransactions = [];
    const maxYears = 25;
    let consecutiveEmptyYears = 0;
    const today = new Date();

    for (let yearOffset = 0; yearOffset < maxYears; yearOffset++) {
      // Calculate year range (going backwards)
      const yearEnd = new Date(today);
      yearEnd.setFullYear(yearEnd.getFullYear() - yearOffset);

      const yearStart = new Date(yearEnd);
      yearStart.setFullYear(yearStart.getFullYear() - 1);
      yearStart.setDate(yearStart.getDate() + 1); // Day after to avoid overlap

      const startStr = yearStart.toISOString().split('T')[0];
      const endStr = yearEnd.toISOString().split('T')[0];

      console.log(`[SCHWAB] Fetching year ${yearOffset + 1}: ${startStr} to ${endStr}...`);

      try {
        const yearTxs = await this.fetchTransactionsUncapped(accessToken, accountHash, startStr, endStr);
        const count = yearTxs.length;
        console.log(`[SCHWAB] Year ${yearOffset + 1}: ${count} transactions`);

        if (count === 0) {
          consecutiveEmptyYears++;
          if (consecutiveEmptyYears >= 2) {
            console.log(`[SCHWAB] 2 consecutive empty years - stopping search`);
            break;
          }
        } else {
          consecutiveEmptyYears = 0;
          allTransactions.push(...yearTxs);
        }
      } catch (error) {
        // If we get an error (like "no data available"), treat as empty year
        console.error(`[SCHWAB] Year ${yearOffset + 1} fetch error:`, error.response?.data?.message || error.message);
        consecutiveEmptyYears++;
        if (consecutiveEmptyYears >= 2) {
          console.log(`[SCHWAB] 2 consecutive empty/error years - stopping search`);
          break;
        }
      }
    }

    console.log(`[SCHWAB] Total fetched for account: ${allTransactions.length} transactions`);
    return allTransactions;
  }

  /**
   * Fetch transactions for a specific date range (with chunking for ranges > 1 year)
   */
  async getTransactionsForRange(accessToken, accountHash, startDate, endDate) {
    const end = endDate || new Date().toISOString().split('T')[0];
    const chunks = this.getDateChunks(startDate, end);
    let allTransactions = [];

    for (const chunk of chunks) {
      console.log(`[SCHWAB] Fetching transactions from ${chunk.start} to ${chunk.end}...`);

      try {
        const chunkTxs = await this.fetchTransactionsUncapped(accessToken, accountHash, chunk.start, chunk.end);
        console.log(`[SCHWAB] Fetched ${chunkTxs.length} transactions for this period`);
        allTransactions = allTransactions.concat(chunkTxs);
      } catch (error) {
        console.error('[SCHWAB] Transaction fetch error:', error.response?.status || error.message);
        throw error;
      }
    }

    return allTransactions;
  }

  /**
   * Split date range into chunks of max 1 year each (Schwab API limit)
   */
  getDateChunks(startDate, endDate) {
    const chunks = [];
    const start = new Date(startDate);
    const end = new Date(endDate);
    const maxDays = 364;

    let chunkStart = new Date(start);

    while (chunkStart <= end) {
      let chunkEnd = new Date(chunkStart);
      chunkEnd.setDate(chunkEnd.getDate() + maxDays);

      if (chunkEnd > end) {
        chunkEnd = end;
      }

      chunks.push({
        start: chunkStart.toISOString().split('T')[0],
        end: chunkEnd.toISOString().split('T')[0]
      });

      chunkStart = new Date(chunkEnd);
      chunkStart.setDate(chunkStart.getDate() + 1);
    }

    return chunks;
  }

  /**
   * Format date for Schwab API (requires full ISO-8601 with milliseconds)
   * @param {string} dateStr - Date string (YYYY-MM-DD or ISO format)
   * @returns {string} - Formatted date string
   */
  formatDateForApi(dateStr, endOfDay = false) {
    // If already in full ISO format, return as is
    if (dateStr.includes('T') && dateStr.includes('Z')) {
      return dateStr;
    }

    // Convert YYYY-MM-DD to full ISO-8601 format
    const time = endOfDay ? 'T23:59:59.000Z' : 'T00:00:00.000Z';
    const date = new Date(dateStr + time);
    return date.toISOString();
  }

  /**
   * Parse Schwab transactions into TradeTally trade format
   * Matches opening and closing transactions to create complete trades
   * @param {Array} transactions - Raw Schwab transactions
   * @returns {Array} - Parsed trades (matched with entry and exit)
   */
  parseTransactions(transactions) {
    // First, extract valid trade transactions
    const validTransactions = [];
    for (const tx of transactions) {
      const parsed = this.parseTransactionDetails(tx);
      if (parsed) {
        validTransactions.push(parsed);
      }
    }

    console.log(`[SCHWAB] Found ${validTransactions.length} valid trade transactions`);

    // Sort by time (oldest first for FIFO matching)
    validTransactions.sort((a, b) => this._compareTransactionsForMatching(a, b));

    // Match opening and closing transactions using FIFO
    let trades = this.matchTransactions(validTransactions);

    // Futures: Schwab positions API is unreliable; align opens to fill-stream net
    // (within this fetch window, unmatched FIFO opens should equal fill-net).
    const futuresFillNet = this.buildFillNetPositionMap(validTransactions);
    const beforeFutOpens = trades.filter(t => t.instrumentType === 'future' && t.exitPrice == null).length;
    trades = this.reconcileOpenFuturesWithFillNet(trades, validTransactions);
    // Never import "open" lots on contracts that already expired / rolled.
    const beforeExpiredFilter = trades.length;
    trades = trades.filter(t => {
      if (t.instrumentType !== 'future') return true;
      const isOpen = t.exitPrice == null && t.exitTime == null;
      if (!isOpen) return true;
      if (!isFuturesContractExpired(t.symbol)) return true;
      console.log(`[SCHWAB] Dropping open on expired futures contract ${t.symbol}`);
      return false;
    });
    if (trades.length !== beforeExpiredFilter) {
      console.log(`[SCHWAB] Removed ${beforeExpiredFilter - trades.length} open(s) on expired futures`);
    }
    const afterFutOpens = trades.filter(t => t.instrumentType === 'future' && t.exitPrice == null).length;
    if (beforeFutOpens !== afterFutOpens) {
      console.log(`[SCHWAB] Futures opens after fill-net/expiry reconcile: ${beforeFutOpens} -> ${afterFutOpens}`);
    }

    console.log(`[SCHWAB] Matched into ${trades.length} complete trades`);

    // Entry order IDs per futures symbol — used to clear journal phantoms that
    // came from these fills without treating window fill-net as absolute position.
    const futuresFillOrderIds = new Map();
    for (const fill of validTransactions) {
      if (fill.instrumentType !== 'future' || !fill.orderId) continue;
      const key = `${fill.accountIdentifier || 'unknown'}|${fill.matchingSymbol || fill.symbol}`;
      if (!futuresFillOrderIds.has(key)) futuresFillOrderIds.set(key, new Set());
      futuresFillOrderIds.get(key).add(String(fill.orderId));
    }
    trades._futuresFillNet = futuresFillNet;
    trades._futuresFillOrderIds = futuresFillOrderIds;
    return trades;
  }

  /**
   * Match opening and closing transactions into complete trades using FIFO
   * Works across days - open Monday, close Tuesday = one complete trade
   * Then groups multiple executions of the same symbol on the same day
   */
  /**
   * FIFO matching key: account + instrument.
   * Multi-account Schwab sync concatenates transactions; without the account
   * segment, a sell in taxable can close lots in an IRA (and leave false opens).
   */
  _positionMatchKey(txOrPos) {
    const instrument = txOrPos.matchingSymbol || txOrPos.symbol || 'UNKNOWN';
    const account = txOrPos.accountIdentifier || 'unknown-account';
    return `${account}|${instrument}`;
  }

  _pushOrphanClose(rawTrades, tx, quantity) {
    if (!(quantity > 0)) return;
    const closeFraction = tx.quantity > 0 ? quantity / tx.quantity : 1;
    rawTrades.push({
      symbol: tx.symbol,
      side: tx.side,
      quantity,
      entryPrice: null,
      exitPrice: tx.price,
      entryTime: null,
      exitTime: tx.time,
      tradeDate: tx.time.split('T')[0],
      commission: (tx.commission || 0) * closeFraction,
      fees: (tx.fees || 0) * closeFraction,
      pnl: tx.netAmount != null ? tx.netAmount * closeFraction : null,
      broker: 'schwab',
      instrumentType: tx.instrumentType,
      pointValue: tx.pointValue,
      contractMonth: tx.contractMonth,
      contractYear: tx.contractYear,
      underlyingAsset: tx.underlyingAsset,
      optionType: tx.optionType,
      strikePrice: tx.strikePrice,
      expirationDate: tx.expirationDate,
      underlyingSymbol: tx.underlyingSymbol,
      matchingSymbol: tx.matchingSymbol,
      cusip: tx.cusip,
      accountIdentifier: tx.accountIdentifier,
      roundTripId: 0, // No matching open - unique round-trip
      executionData: [{
        datetime: tx.time,
        price: tx.price,
        quantity,
        side: tx.side,
        type: 'exit',
        orderId: tx.orderId
      }]
    });
  }

  matchTransactions(transactions) {
    const rawTrades = [];
    // Track open positions per account+symbol: { "****1234|AAPL": [{ qty, price, time, ... }] }
    const openPositions = {};
    // Track round-trip IDs per account+symbol - increments each time position goes flat then re-opens
    const roundTripCounters = {};

    // Sort all transactions by time
    const sorted = [...transactions].sort((a, b) => this._compareTransactionsForMatching(a, b));

    // Debug: Log position effects we're seeing
    const effectCounts = {};
    for (const tx of sorted) {
      const effect = tx.positionEffect || 'UNKNOWN';
      effectCounts[effect] = (effectCounts[effect] || 0) + 1;
    }
    console.log('[SCHWAB] Position effects found:', effectCounts);

    for (const tx of sorted) {
      const symbol = tx.symbol;
      const positionKey = this._positionMatchKey(tx);

      // Handle transactions without positionEffect - try to infer from context
      let positionEffect = tx.positionEffect;
      if (!positionEffect) {
        // For TOS trades that might not have positionEffect, try to infer it
        // If we have open positions for this symbol *in this account*, assume it's closing
        // Otherwise, assume it's opening
        console.log(`[SCHWAB] Transaction without positionEffect: ${symbol} qty=${tx.quantity} price=${tx.price} account=${tx.accountIdentifier || 'n/a'} - attempting to infer`);

        if (openPositions[positionKey] && openPositions[positionKey].length > 0) {
          positionEffect = 'CLOSING';
          console.log(`[SCHWAB] Inferred as CLOSING (found open positions)`);
        } else {
          positionEffect = 'OPENING';
          console.log(`[SCHWAB] Inferred as OPENING (no open positions)`);
        }
      }

      if (positionEffect === 'OPENING') {
        // Add to open positions queue
        if (!openPositions[positionKey]) {
          openPositions[positionKey] = [];
        }
        // If position was flat (empty queue), this starts a new round-trip
        if (openPositions[positionKey].length === 0) {
          roundTripCounters[positionKey] = (roundTripCounters[positionKey] || 0) + 1;
        }
        openPositions[positionKey].push({
          symbol,
          qty: tx.quantity,
          price: tx.price,
          time: tx.time,
          commission: tx.commission || 0,
          fees: tx.fees || 0,
          side: tx.side,
          instrumentType: tx.instrumentType,
          pointValue: tx.pointValue,
          contractMonth: tx.contractMonth,
          contractYear: tx.contractYear,
          underlyingAsset: tx.underlyingAsset,
          optionType: tx.optionType,
          strikePrice: tx.strikePrice,
          expirationDate: tx.expirationDate,
          underlyingSymbol: tx.underlyingSymbol,
          matchingSymbol: tx.matchingSymbol,
          cusip: tx.cusip,
          orderId: tx.orderId,
          accountIdentifier: tx.accountIdentifier,
          roundTripId: roundTripCounters[positionKey]
        });
      } else if (positionEffect === 'CLOSING') {
        // Match against open positions using FIFO within the same account only
        if (!openPositions[positionKey] || openPositions[positionKey].length === 0) {
          // No matching open in this account - position was opened before sync window
          this._pushOrphanClose(rawTrades, tx, tx.quantity);
          continue;
        }

        let remainingCloseQty = tx.quantity;

        while (remainingCloseQty > 0 && openPositions[positionKey] && openPositions[positionKey].length > 0) {
          const openPos = openPositions[positionKey][0];
          const matchQty = Math.min(remainingCloseQty, openPos.qty);

          // Prorate the entry-side costs for this slice and consume them from
          // the lot. Prorating against the remaining qty without decrementing
          // the costs over-counted entry commission on partial exits (a 50/50
          // split of a 100-share lot attributed 0.5 + 1.0 = 1.5x the actual).
          const entryCommission = openPos.qty > 0 ? (openPos.commission || 0) * matchQty / openPos.qty : 0;
          const entryFees = openPos.qty > 0 ? (openPos.fees || 0) * matchQty / openPos.qty : 0;

          // Create matched trade
          const pnl = this.calculatePnL(openPos.price, tx.price, matchQty, openPos.side, openPos.instrumentType, openPos.pointValue ?? tx.pointValue);

          rawTrades.push({
            symbol,
            side: openPos.side,
            quantity: matchQty,
            entryPrice: openPos.price,
            exitPrice: tx.price,
            entryTime: openPos.time,
            exitTime: tx.time,
            tradeDate: tx.time.split('T')[0], // Use exit date as trade date
            commission: entryCommission + (tx.commission * matchQty / tx.quantity || 0),
            fees: entryFees + (tx.fees * matchQty / tx.quantity || 0),
            pnl,
            broker: 'schwab',
            instrumentType: openPos.instrumentType,
            pointValue: openPos.pointValue ?? tx.pointValue,
            contractMonth: openPos.contractMonth ?? tx.contractMonth,
            contractYear: openPos.contractYear ?? tx.contractYear,
            underlyingAsset: openPos.underlyingAsset ?? tx.underlyingAsset,
            optionType: openPos.optionType,
            strikePrice: openPos.strikePrice,
            expirationDate: openPos.expirationDate,
            underlyingSymbol: openPos.underlyingSymbol,
            matchingSymbol: openPos.matchingSymbol,
            cusip: openPos.cusip,
            accountIdentifier: openPos.accountIdentifier,
            roundTripId: openPos.roundTripId,
            executionData: [
              {
                datetime: openPos.time,
                price: openPos.price,
                quantity: matchQty,
                side: openPos.side,
                type: 'entry',
                orderId: openPos.orderId
              },
              {
                datetime: tx.time,
                price: tx.price,
                quantity: matchQty,
                side: tx.side,
                type: 'exit',
                orderId: tx.orderId
              }
            ]
          });

          remainingCloseQty -= matchQty;
          openPos.qty -= matchQty;
          openPos.commission = Math.max(0, (openPos.commission || 0) - entryCommission);
          openPos.fees = Math.max(0, (openPos.fees || 0) - entryFees);

          if (openPos.qty <= 0) {
            openPositions[positionKey].shift();
          }
        }

        // Close qty that exceeds same-account opens (opened before sync window)
        if (remainingCloseQty > 0) {
          this._pushOrphanClose(rawTrades, tx, remainingCloseQty);
        }
      }
    }

    // Add remaining open positions as open trades
    for (const [positionKey, positions] of Object.entries(openPositions)) {
      for (const pos of positions) {
        if (pos.qty > 0) {
          console.log(`[SCHWAB] Remaining open position: ${positionKey} qty=${pos.qty} side=${pos.side} time=${pos.time}`);
          rawTrades.push({
            symbol: pos.symbol,
            side: pos.side,
            quantity: pos.qty,
            entryPrice: pos.price,
            exitPrice: null,
            entryTime: pos.time,
            exitTime: null,
            tradeDate: pos.time.split('T')[0],
            commission: pos.commission,
            fees: pos.fees,
            pnl: null,
            broker: 'schwab',
            instrumentType: pos.instrumentType,
            pointValue: pos.pointValue,
            contractMonth: pos.contractMonth,
            contractYear: pos.contractYear,
            underlyingAsset: pos.underlyingAsset,
            optionType: pos.optionType,
            strikePrice: pos.strikePrice,
            expirationDate: pos.expirationDate,
            underlyingSymbol: pos.underlyingSymbol,
            matchingSymbol: pos.matchingSymbol,
            cusip: pos.cusip,
            accountIdentifier: pos.accountIdentifier,
            roundTripId: pos.roundTripId,
            executionData: [{
              datetime: pos.time,
              price: pos.price,
              quantity: pos.qty,
              side: pos.side,
              type: 'entry',
              orderId: pos.orderId
            }]
          });
        }
      }
    }

    // Log raw trades before grouping
    console.log(`[SCHWAB] Raw matched trades: ${rawTrades.length}`);

    // Group trades by symbol and trade date (exit date for closed, entry date for open)
    const trades = this.groupTrades(rawTrades);

    // Log summary
    const closedTrades = trades.filter(t => t.exitPrice !== null).length;
    const openTrades = trades.filter(t => t.exitPrice === null).length;
    console.log(`[SCHWAB] After grouping: ${trades.length} trades (${closedTrades} closed, ${openTrades} open)`);

    return trades;
  }

  /**
   * Group multiple executions of the same symbol on the same day into single trades
   * Uses weighted average prices for entries and exits
   */
  groupTrades(rawTrades) {
    const groupedMap = new Map();

    for (const trade of rawTrades) {
      // Create group key: symbol + trade date + side + account + round-trip + open/closed
      // roundTripId ensures separate round-trips (position went flat then re-opened) are not merged.
      // open vs closed must stay separate: an open remainder on the same calendar day as
      // other exits in the round-trip would otherwise merge into a "closed" trade with
      // entry qty > exit qty (and hide leftover inventory).
      const instrumentKey = trade.instrumentType === 'option'
        ? [
            trade.matchingSymbol || trade.symbol,
            trade.expirationDate || '',
            trade.optionType || '',
            trade.strikePrice ?? ''
          ].join('|')
        : (trade.matchingSymbol || trade.symbol);
      const openClosed = trade.exitPrice == null ? 'open' : 'closed';
      const key = `${instrumentKey}|${trade.tradeDate}|${trade.side}|${trade.accountIdentifier || 'default'}|${trade.roundTripId || 0}|${openClosed}`;

      if (!groupedMap.has(key)) {
        groupedMap.set(key, {
          symbol: trade.symbol,
          side: trade.side,
          tradeDate: trade.tradeDate,
          broker: trade.broker,
          instrumentType: trade.instrumentType,
          pointValue: trade.pointValue || null,
          contractMonth: trade.contractMonth || null,
          contractYear: trade.contractYear || null,
          underlyingAsset: trade.underlyingAsset || null,
          optionType: trade.optionType,
          strikePrice: trade.strikePrice,
          expirationDate: trade.expirationDate,
          underlyingSymbol: trade.underlyingSymbol,
          cusip: trade.cusip,
          accountIdentifier: trade.accountIdentifier,
          // Aggregation fields
          totalQuantity: 0,
          totalEntryValue: 0,
          totalExitValue: 0,
          entryQuantity: 0,
          exitQuantity: 0,
          totalCommission: 0,
          totalFees: 0,
          totalPnL: 0,
          hasEntry: false,
          hasExit: false,
          earliestEntryTime: null,
          latestExitTime: null,
          executionData: []
        });
      }

      const group = groupedMap.get(key);

      // Aggregate quantities and values
      group.totalQuantity += trade.quantity;
      group.totalCommission += trade.commission || 0;
      group.totalFees += trade.fees || 0;

      if (trade.entryPrice !== null) {
        group.totalEntryValue += trade.entryPrice * trade.quantity;
        group.entryQuantity += trade.quantity;
        group.hasEntry = true;
        if (!group.earliestEntryTime || new Date(trade.entryTime) < new Date(group.earliestEntryTime)) {
          group.earliestEntryTime = trade.entryTime;
        }
      }

      if (trade.exitPrice !== null) {
        group.totalExitValue += trade.exitPrice * trade.quantity;
        group.exitQuantity += trade.quantity;
        group.hasExit = true;
        if (!group.latestExitTime || new Date(trade.exitTime) > new Date(group.latestExitTime)) {
          group.latestExitTime = trade.exitTime;
        }
      }

      if (trade.pnl !== null) {
        group.totalPnL += trade.pnl;
      }

      // Merge execution data
      if (trade.executionData) {
        group.executionData.push(...trade.executionData);
      }
    }

    // Convert grouped data back to trade format
    const groupedTrades = [];
    for (const group of groupedMap.values()) {
      const entryPrice = group.hasEntry ? Math.round((group.totalEntryValue / group.entryQuantity) * 10000) / 10000 : null;
      const exitPrice = group.hasExit ? Math.round((group.totalExitValue / group.exitQuantity) * 10000) / 10000 : null;

      // Recalculate P&L if we have both entry and exit
      let pnl = group.totalPnL;
      if (group.hasEntry && group.hasExit && entryPrice && exitPrice) {
        pnl = this.calculatePnL(entryPrice, exitPrice, group.totalQuantity, group.side, group.instrumentType, group.pointValue);
      }

      groupedTrades.push({
        symbol: group.symbol,
        side: group.side,
        quantity: group.totalQuantity,
        entryPrice,
        exitPrice,
        entryTime: group.earliestEntryTime,
        exitTime: group.latestExitTime,
        tradeDate: group.tradeDate,
        commission: Math.round(group.totalCommission * 100) / 100,
        fees: Math.round(group.totalFees * 100) / 100,
        pnl: pnl !== null ? Math.round(pnl * 100) / 100 : null,
        broker: group.broker,
        instrumentType: group.instrumentType,
        pointValue: group.pointValue,
        contractMonth: group.contractMonth,
        contractYear: group.contractYear,
        underlyingAsset: group.underlyingAsset,
        optionType: group.optionType,
        strikePrice: group.strikePrice,
        expirationDate: group.expirationDate,
        underlyingSymbol: group.underlyingSymbol,
        cusip: group.cusip,
        accountIdentifier: group.accountIdentifier,
        executionData: group.executionData
      });
    }

    return groupedTrades;
  }

  /**
   * Create a partial trade when we only have one side
   */
  createPartialTrade(tx, side) {
    if (side === 'close') {
      return {
        symbol: tx.symbol,
        side: tx.side,
        quantity: tx.quantity,
        entryPrice: null,
        exitPrice: tx.price,
        entryTime: null,
        exitTime: tx.time,
        tradeDate: tx.time.split('T')[0],
        commission: tx.commission || 0,
        fees: tx.fees || 0,
        pnl: tx.netAmount, // Use Schwab's reported P&L
        broker: 'schwab',
        instrumentType: tx.instrumentType,
        optionType: tx.optionType,
        strikePrice: tx.strikePrice,
        expirationDate: tx.expirationDate,
        underlyingSymbol: tx.underlyingSymbol,
        cusip: tx.cusip
      };
    }
    return null;
  }

  /**
   * Calculate P&L for a matched trade
   */
  calculatePnL(entryPrice, exitPrice, quantity, side, instrumentType, pointValue = null) {
    if (!entryPrice || !exitPrice) return null;

    let multiplier = 1;
    if (instrumentType === 'option') {
      multiplier = 100;
    } else if (instrumentType === 'future') {
      multiplier = pointValue != null ? Number(pointValue) || 1 : 1;
    }
    const diff = exitPrice - entryPrice;
    const pnl = side === 'long' ? diff * quantity * multiplier : -diff * quantity * multiplier;

    return Math.round(pnl * 100) / 100;
  }

  /**
   * Schwab futures symbols look like `/MESU26:XCME`. Normalize to `MESU26`
   * so matching and point-value lookup share one contract key.
   */
  _normalizeSchwabFuturesSymbol(rawSymbol) {
    if (!rawSymbol) return null;
    let symbol = String(rawSymbol).toUpperCase().replace(/\s+/g, '').trim();
    if (symbol.startsWith('/')) symbol = symbol.slice(1);
    const colonIdx = symbol.indexOf(':');
    if (colonIdx > 0) symbol = symbol.slice(0, colonIdx);
    return symbol || null;
  }

  /**
   * Pick the tradeable security leg from a Schwab TRADE.
   * Futures fills put several CURRENCY cash/fee legs before the FUTURE
   * instrument; those legs have assetType but often no feeType, so a naive
   * "first non-fee item" pick skips the contract entirely.
   */
  _findTradeableTransferItem(transferItems) {
    if (!Array.isArray(transferItems)) return null;
    return transferItems.find(ti => {
      if (!ti?.instrument?.assetType || ti.feeType) return false;
      const assetType = String(ti.instrument.assetType).toUpperCase();
      return SCHWAB_TRADEABLE_ASSET_TYPES.includes(assetType);
    }) || null;
  }

  /**
   * Parse a single Schwab transaction into structured data
   * @param {object} tx - Raw transaction from Schwab API
   * @returns {object|null} - Parsed transaction details or null if not valid
   */
  parseTransactionDetails(tx) {
    // Only process TRADE type transactions
    if (tx.type !== 'TRADE') {
      // Log non-TRADE transactions to help debug TOS issues
      if (tx.type && tx.transferItems?.[0]?.instrument?.symbol) {
        console.log(`[SCHWAB] Skipping non-TRADE transaction: type=${tx.type}, symbol=${tx.transferItems[0].instrument.symbol}`);
      }
      return null;
    }

    // Get the transfer items (contains instrument and trade details)
    const transferItems = tx.transferItems || [];
    if (transferItems.length === 0) {
      return null;
    }

    // Prefer tradeable securities. Futures TRADES list CURRENCY cash legs first
    // (often without feeType), which previously caused every FUTURE fill to be dropped.
    const item = this._findTradeableTransferItem(transferItems);
    if (!item) {
      const first = transferItems.find(ti => ti.instrument?.assetType && !ti.feeType);
      if (first?.instrument?.assetType) {
        console.log(`[SCHWAB] Skipping asset type: ${first.instrument.assetType} for symbol: ${first.instrument.symbol}`);
      }
      return null;
    }

    const instrument = item.instrument || {};
    const assetType = instrument.assetType?.toUpperCase();

    const rawSymbol = instrument.symbol;
    if (!rawSymbol) {
      return null;
    }
    let matchingSymbol = String(rawSymbol).toUpperCase().replace(/\s+/g, ' ').trim();

    // Skip currency symbols (but allow futures symbols like /ES, /NQ that TOS uses)
    if (matchingSymbol.startsWith('CURRENCY_') || matchingSymbol === 'USD' || matchingSymbol === 'CASH') {
      return null;
    }

    // Get price and quantity
    const price = parseFloat(item.price) || 0;
    const amount = parseFloat(item.amount) || 0;
    const signedQuantity = amount;

    // Skip if no price or quantity (not a real trade)
    if (price === 0 || amount === 0) {
      return null;
    }

    // Determine side from positionEffect and amount
    let side;
    const positionEffect = item.positionEffect;

    // OPENING with positive amount = buy/long entry
    // OPENING with negative amount = short entry
    // CLOSING with positive amount = buy to cover (closing short)
    // CLOSING with negative amount = sell (closing long)
    if (positionEffect === 'OPENING') {
      side = amount > 0 ? 'long' : 'short';
    } else if (positionEffect === 'CLOSING') {
      side = amount > 0 ? 'long' : 'short';
    } else {
      // Default based on amount sign
      side = amount > 0 ? 'long' : 'short';
    }

    // Determine instrument type
    let instrumentType = 'stock';
    let optionType = null;
    let strikePrice = null;
    let expirationDate = null;
    let underlyingSymbol = null;
    let symbol = matchingSymbol;
    let pointValue = null;
    let contractMonth = null;
    let contractYear = null;
    let underlyingAsset = null;

    if (assetType === 'OPTION') {
      instrumentType = 'option';
      const parsedOption = this._parseSchwabOptionSymbol(matchingSymbol);
      // Parse option details from instrument if available
      optionType = instrument.putCall?.toLowerCase() || parsedOption?.optionType || null;
      strikePrice = instrument.strikePrice ?? parsedOption?.strikePrice ?? null;
      expirationDate = instrument.expirationDate || parsedOption?.expirationDate || null;
      // Normalize: the open-position grouping key is built from the
      // underlying symbol, and the Schwab API's casing is not guaranteed.
      const rawUnderlying = instrument.underlyingSymbol || parsedOption?.underlyingSymbol || null;
      underlyingSymbol = rawUnderlying ? String(rawUnderlying).trim().toUpperCase() : null;
      symbol = underlyingSymbol || matchingSymbol;
    } else if (assetType === 'FUTURE') {
      instrumentType = 'future';
      const normalizedFuture = this._normalizeSchwabFuturesSymbol(matchingSymbol);
      if (normalizedFuture) {
        symbol = normalizedFuture;
        matchingSymbol = normalizedFuture;
      }
      const contract = parseFuturesContractFields(symbol);
      underlyingSymbol = contract?.underlyingAsset || extractUnderlyingFromFuturesSymbol(symbol);
      if (underlyingSymbol) {
        pointValue = getFuturesPointValue(underlyingSymbol);
      }
      contractMonth = contract?.contractMonth || null;
      contractYear = contract?.contractYear || null;
      underlyingAsset = underlyingSymbol;
      console.log(`[SCHWAB] Processing TOS futures symbol: ${rawSymbol} -> ${symbol}`);
    }

    const quantity = Math.abs(amount);

    // Extract commission from transferItems with feeType = COMMISSION
    let commission = 0;
    let fees = 0;
    for (const ti of transferItems) {
      if (ti.feeType === 'COMMISSION') {
        commission += Math.abs(parseFloat(ti.cost) || 0);
      } else if (ti.feeType) {
        fees += Math.abs(parseFloat(ti.cost) || 0);
      }
    }

    const time = this._getTransactionTime(tx);

    // Net amount from transaction (includes P&L for closing trades)
    const netAmount = tx.netAmount;

    // Return transaction details for matching
    return {
      symbol,
      side,
      quantity,
      signedQuantity,
      price,
      time,
      matchingSymbol,
      positionEffect, // OPENING or CLOSING
      commission,
      fees,
      netAmount,
      instrumentType,
      optionType,
      strikePrice,
      expirationDate,
      underlyingSymbol: (instrumentType === 'option' || instrumentType === 'future') ? underlyingSymbol : null,
      pointValue,
      contractMonth,
      contractYear,
      underlyingAsset,
      cusip: instrument.cusip,
      orderId: tx.orderId?.toString() || tx.activityId?.toString(),
      accountIdentifier: tx._accountIdentifier // Redacted account identifier (e.g., "****1234")
    };
  }

  /**
   * Sync trades from Schwab
   * @param {object} connection - BrokerConnection with credentials
   * @param {object} options - Sync options
   */
  async syncTrades(connection, options = {}) {
    const { startDate, endDate, syncLogId } = options;

    console.log(`[SCHWAB] Starting sync for connection ${connection.id}`);

    // Ensure we have a valid token
    const { accessToken, needsReauth } = await this.ensureValidToken(connection);

    if (needsReauth) {
      throw new Error('Schwab authentication expired. Please re-connect your account.');
    }

    // Update sync log status
    if (syncLogId) {
      await BrokerConnection.updateSyncLog(syncLogId, 'fetching');
    }

    // Sync all Schwab accounts except those listed in brokerMetadata.excludedSchwabAccounts
    const excludedLast4s = this.getExcludedSchwabAccountLast4s(connection);
    if (excludedLast4s.length > 0) {
      console.log(`[SCHWAB] Excluding accounts ending in: ${excludedLast4s.join(', ')}`);
    }

    const accounts = await this.getAccountNumbers(accessToken);
    if (!accounts || accounts.length === 0) {
      throw new Error('No Schwab accounts found');
    }

    const accountsToSync = accounts.filter(account => {
      const redacted = this.redactAccountNumber(account.accountNumber);
      const excluded = this.isSchwabAccountExcluded(redacted, excludedLast4s);
      if (excluded) {
        console.log(`[SCHWAB] Skipping excluded account ${redacted}`);
      }
      return !excluded;
    });

    if (accountsToSync.length === 0) {
      throw new Error('No Schwab accounts left to sync after exclusions');
    }

    console.log(`[SCHWAB] Found ${accounts.length} accounts, syncing ${accountsToSync.length}`);

    // Fetch transactions from included accounts, tagging each with the account identifier
    let allTransactions = [];
    for (const account of accountsToSync) {
      const redactedAccount = this.redactAccountNumber(account.accountNumber);
      console.log(`[SCHWAB] Fetching transactions for account ${redactedAccount}...`);
      try {
        const transactions = await this.getTransactions(
          accessToken,
          account.hashValue,
          startDate,
          endDate
        );
        // Tag each transaction with the redacted account identifier
        const taggedTransactions = transactions.map(tx => ({
          ...tx,
          _accountIdentifier: redactedAccount
        }));
        console.log(`[SCHWAB] Account ${redactedAccount}: ${transactions.length} transactions`);
        allTransactions = allTransactions.concat(taggedTransactions);
      } catch (error) {
        console.error(`[SCHWAB] Failed to fetch account ${redactedAccount}:`, error.message);
        // Continue with other accounts
      }
    }

    console.log(`[SCHWAB] Total transactions fetched: ${allTransactions.length}`);

    // Update sync log status
    if (syncLogId) {
      await BrokerConnection.updateSyncLog(syncLogId, 'parsing', {
        tradesFetched: allTransactions.length
      });
    }

    // Parse transactions to trades
    let trades = this.parseTransactions(allTransactions);
    const futuresFillOrderIds = trades._futuresFillOrderIds;
    console.log(`[SCHWAB] Parsed ${trades.length} trades from ${allTransactions.length} transactions`);

    // Reconcile FIFO open remnants against live broker positions. TRADE history
    // alone misses journals / corp-actions, which leaves false opens (and can
    // omit real holds that never appear as unmatched openings).
    let brokerPositions = null;
    let brokerPositionsFlat = false;
    try {
      const accountsWithPositions = await this.getAccounts(accessToken, { fields: 'positions' });

      // Only reconcile against a payload we can trust: Schwab omits `positions`
      // for a flat account (fine, that IS an empty book) but also sometimes
      // withholds it while the account still holds value (not fine -- acting on
      // that empty map would delete every real open position).
      const assessment = this.assessBrokerPositions(accountsWithPositions, excludedLast4s);
      if (!assessment.usable) {
        throw new Error(`untrustworthy positions payload: ${assessment.reason}`);
      }
      brokerPositionsFlat = assessment.flat;

      brokerPositions = this.buildBrokerEquityPositionMap(accountsWithPositions, excludedLast4s);
      console.log(`[SCHWAB] Live equity positions: ${brokerPositions.size} (${assessment.reason})`);
      const beforeOpen = trades.filter(t => t.exitPrice == null && t.exitTime == null).length;
      trades = this.reconcileOpenTradesWithBrokerPositions(trades, brokerPositions);
      const afterOpen = trades.filter(t => t.exitPrice == null && t.exitTime == null).length;
      console.log(`[SCHWAB] Open trades after position reconcile: ${beforeOpen} -> ${afterOpen}`);
    } catch (error) {
      console.error('[SCHWAB] Position reconcile skipped:', error.response?.data?.message || error.message);
    }

    // Log trade breakdown for debugging TOS issues
    const tradeBreakdown = {
      stocks: trades.filter(t => t.instrumentType === 'stock').length,
      options: trades.filter(t => t.instrumentType === 'option').length,
      futures: trades.filter(t => t.instrumentType === 'future').length,
      tosSymbols: trades.filter(t => t.symbol?.startsWith('/')).length,
      openTrades: trades.filter(t => !t.exitPrice).length,
      closedTrades: trades.filter(t => t.exitPrice).length
    };
    console.log(`[SCHWAB] Trade breakdown:`, tradeBreakdown);

    // Update sync log status
    if (syncLogId) {
      await BrokerConnection.updateSyncLog(syncLogId, 'importing');
    }

    // Import trades with connection ID for tracking
    const result = await this.importTrades(connection.userId, connection.id, trades);

    // Clear journal futures opens that came from this sync's fills but are no
    // longer open after FIFO + fill-net (Schwab positions API omits FUTURES).
    // Only touches opens whose entry order IDs appear in this fetch — never
    // treats window fill-net as absolute account position.
    try {
      const removed = await this.dropPhantomFuturesOpens(
        connection.userId,
        trades,
        futuresFillOrderIds
      );
      if (removed > 0) {
        result.imported += removed; // surface as activity
        console.log(`[SCHWAB] Removed ${removed} phantom futures open(s) from journal`);
      }
    } catch (error) {
      console.warn('[SCHWAB] Phantom futures open cleanup failed:', error.message);
    }

    // Expired contracts cannot still be open at the broker — drop journal leftovers
    // even when those symbols had no fills in this sync window (rolled months).
    try {
      const expiredRemoved = await this.dropExpiredFuturesOpens(connection.userId);
      if (expiredRemoved > 0) {
        result.imported += expiredRemoved;
        console.log(`[SCHWAB] Removed ${expiredRemoved} expired futures open(s) from journal`);
      }
    } catch (error) {
      console.warn('[SCHWAB] Expired futures open cleanup failed:', error.message);
    }

    // Equity equivalent of the futures cleanup above: trim persisted open lots
    // that exceed live broker inventory. The pre-import reconcile can only
    // filter this run's parse output, so phantom opens written by earlier syncs
    // would otherwise stay open forever (a re-sync just counts them dupes).
    if (brokerPositions) {
      try {
        const syncedAccountIdentifiers = accountsToSync.map(a => this.redactAccountNumber(a.accountNumber));
        const repair = await this.reconcilePersistedOpenEquity(
          connection.userId,
          connection.id,
          brokerPositions,
          syncedAccountIdentifiers,
          { allowEmpty: brokerPositionsFlat }
        );
        if (repair.deleted.length || repair.resized.length) {
          console.log(
            `[SCHWAB] Persisted open equity repaired: ${repair.deleted.length} lot(s) deleted, ` +
            `${repair.resized.length} resized (kept ${repair.keptLots} in sync)`
          );
          await AnalyticsCache.invalidate(connection.userId);
        }
      } catch (error) {
        console.warn('[SCHWAB] Persisted open equity reconcile failed:', error.message);
      }
    }

    console.log(`[SCHWAB] Sync complete: ${result.imported} imported, ${result.duplicates} duplicates`);

    return result;
  }

  /**
   * Delete journal futures opens that this sync's fills produced, when the
   * reconciled trade list no longer has a matching open (flat / closed).
   *
   * @param {string} userId
   * @param {Array} reconciledTrades - trades after FIFO + fill-net + equity reconcile
   * @param {Map<string, Set<string>>} futuresFillOrderIds - account|symbol -> orderIds
   */
  async dropPhantomFuturesOpens(userId, reconciledTrades, futuresFillOrderIds) {
    if (!futuresFillOrderIds || futuresFillOrderIds.size === 0) return 0;

    const stillOpenKeys = new Set(
      (reconciledTrades || [])
        .filter(t => t.instrumentType === 'future' && t.exitPrice == null && t.exitTime == null)
        .map(t => `${t.accountIdentifier || 'unknown'}|${t.symbol}|${t.side}`)
    );

    const { rows } = await db.query(
      `SELECT id, symbol, side, account_identifier, executions
       FROM trades
       WHERE user_id = $1
         AND instrument_type = 'future'
         AND exit_price IS NULL
         AND exit_time IS NULL`,
      [userId]
    );

    let removed = 0;
    for (const row of rows) {
      const symbolKey = `${row.account_identifier || 'unknown'}|${row.symbol}`;
      const fillOrderIds = futuresFillOrderIds.get(symbolKey);
      if (!fillOrderIds || fillOrderIds.size === 0) continue;

      let execs = row.executions || [];
      if (typeof execs === 'string') {
        try { execs = JSON.parse(execs); } catch { execs = []; }
      }
      const entryOrderIds = (Array.isArray(execs) ? execs : [])
        .filter(e => e && e.type === 'entry' && e.orderId)
        .map(e => String(e.orderId));
      if (entryOrderIds.length === 0) continue;
      if (!entryOrderIds.some(id => fillOrderIds.has(id))) continue;

      const openKey = `${symbolKey}|${row.side}`;
      if (stillOpenKeys.has(openKey)) continue;

      console.log(`[SCHWAB] Deleting phantom futures open ${row.id} ${row.symbol} ${row.side} (fills in sync, no reconciled open)`);
      await Trade.delete(row.id, userId, { skipOptionGrouping: true });
      removed++;
    }
    return removed;
  }

  /**
   * Delete journal futures opens whose contract month has already expired.
   * Covers rolled leftovers (e.g. MNQH26 / MNQM26) that no longer appear in
   * the TRADE stream and therefore escape fill-order phantom cleanup.
   */
  async dropExpiredFuturesOpens(userId) {
    const { rows } = await db.query(
      `SELECT id, symbol, side
       FROM trades
       WHERE user_id = $1
         AND instrument_type = 'future'
         AND exit_price IS NULL
         AND exit_time IS NULL`,
      [userId]
    );

    let removed = 0;
    for (const row of rows) {
      if (!isFuturesContractExpired(row.symbol)) continue;
      console.log(`[SCHWAB] Deleting expired futures open ${row.id} ${row.symbol} ${row.side}`);
      await Trade.delete(row.id, userId, { skipOptionGrouping: true });
      removed++;
    }
    return removed;
  }

  /**
   * Import parsed trades into the database
   * @param {string} userId - User ID
   * @param {string} connectionId - Broker connection ID for tracking synced trades
   * @param {Array} trades - Parsed trades
   */
  async importTrades(userId, connectionId, trades) {
    let imported = 0;
    let skipped = 0;
    let failed = 0;
    let duplicates = 0;

    const existingTrades = await this.getExistingTrades(userId, trades);

    for (const tradeData of trades) {
      try {
        // Check for duplicates
        const isDuplicate = this.isDuplicateTrade(tradeData, existingTrades);

        if (isDuplicate) {
          duplicates++;
          continue;
        }

        // Upgrade a previously-imported open lot when the close is now available
        const openMatch = this.findUpgradeableOpenTrade(tradeData, existingTrades);
        if (openMatch) {
          console.log(`[SCHWAB] Upgrading open trade ${openMatch.id} with close for ${tradeData.symbol}`);
          await Trade.update(openMatch.id, userId, {
            exitPrice: tradeData.exitPrice,
            exitTime: tradeData.exitTime,
            executions: tradeData.executionData,
            commission: tradeData.commission,
            fees: tradeData.fees,
            pnl: tradeData.pnl
          }, { skipOptionGrouping: true, skipApiCalls: true });
          openMatch.exit_price = tradeData.exitPrice;
          openMatch.exit_time = tradeData.exitTime;
          openMatch.executions = tradeData.executionData;
          openMatch.pnl = tradeData.pnl;
          await this.removeSiblingTradesSharingEntryOrders(userId, tradeData, openMatch.id, existingTrades);
          imported++;
          continue;
        }

        // Closed trade whose entry orders already appear on remnant opens/partials:
        // drop those remnants and import the authoritative closed lot.
        if (tradeData.exitPrice != null && tradeData.exitPrice !== '') {
          const removed = await this.removeSiblingTradesSharingEntryOrders(userId, tradeData, null, existingTrades);
          if (removed > 0) {
            console.log(`[SCHWAB] Cleared ${removed} remnant(s) before importing closed ${tradeData.symbol}`);
          }
        }

        // Add broker connection ID to track synced trades
        tradeData.brokerConnectionId = connectionId;

        // Create trade
        await Trade.create(userId, tradeData, {
          skipAchievements: true,
          skipApiCalls: true,
          skipOptionGrouping: true
        });

        imported++;

        // Add the newly imported trade to existingTrades to prevent duplicates within same batch
        existingTrades.push({
          symbol: tradeData.symbol,
          side: tradeData.side,
          quantity: tradeData.quantity,
          entry_price: tradeData.entryPrice,
          exit_price: tradeData.exitPrice,
          entry_time: tradeData.entryTime,
          exit_time: tradeData.exitTime,
          trade_date: tradeData.tradeDate,
          pnl: tradeData.pnl,
          executions: tradeData.executionData,
          instrument_type: tradeData.instrumentType || 'stock',
          strike_price: tradeData.strikePrice || null,
          expiration_date: tradeData.expirationDate || null,
          option_type: tradeData.optionType || null,
          underlying_symbol: tradeData.underlyingSymbol || null,
          account_identifier: tradeData.accountIdentifier || null
        });
      } catch (error) {
        console.error(`[SCHWAB] Failed to import trade:`, error.message);
        console.error(`[SCHWAB] Trade details:`, {
          symbol: tradeData.symbol,
          quantity: tradeData.quantity,
          entryPrice: tradeData.entryPrice,
          exitPrice: tradeData.exitPrice,
          tradeDate: tradeData.tradeDate
        });
        failed++;
      }
    }

    await OptionStrategyGroupingService.rebuildUserGroupsSafe(userId, 'Schwab broker sync');
    console.log(`[SCHWAB] Invalidating analytics cache for user ${userId}`);
    await AnalyticsCache.invalidate(userId);

    // Per-row creates skip achievements; run one end-of-batch check instead
    if (imported > 0) {
      const AchievementService = require('../achievementService');
      AchievementService.checkAndAwardAchievements(userId).catch(error => {
        console.warn(`[SCHWAB] Failed to check achievements after sync for user ${userId}:`, error.message);
      });
    }

    return { imported, skipped, failed, duplicates };
  }

  /**
   * Get existing trades for duplicate checking
   * Fetches ALL user trades (not just Schwab) to catch CSV imports too
   */
  async getExistingTrades(userId, incomingTrades = []) {
    if (!Array.isArray(incomingTrades) || incomingTrades.length === 0) {
      return [];
    }

    const { minDate, maxDate } = this.getTradeDateRange(incomingTrades);
    const params = [userId];

    let query = `
      SELECT id, symbol, side, quantity, entry_price, exit_price, entry_time, exit_time,
             executions, trade_date, pnl, instrument_type, strike_price,
             expiration_date, option_type, underlying_symbol, account_identifier
      FROM trades
      WHERE user_id = $1
    `;

    if (minDate && maxDate) {
      params.push(minDate, maxDate);
      query += `
        AND trade_date >= $2
        AND trade_date <= $3
      `;
    }

    query += `
      ORDER BY trade_date DESC, entry_time DESC
    `;

    const result = await db.query(query, params);
    return result.rows;
  }


  /**
   * Find an open journal trade that a newly matched closed trade should upgrade.
   * Happens when sync imported entries before the broker close arrived.
   */
  findUpgradeableOpenTrade(newTrade, existingTrades) {
    if (!newTrade || !Array.isArray(existingTrades)) return null;
    const newHasExit = newTrade.exitPrice != null && newTrade.exitPrice !== '';
    if (!newHasExit) return null;

    const newQty = parseFloat(newTrade.quantity) || 0;
    const newEntryPrice = parseFloat(newTrade.entryPrice) || 0;
    const newTradeDate = newTrade.tradeDate;
    const newAccountIdentifier = newTrade.accountIdentifier || null;
    const newInstrumentType = newTrade.instrumentType || 'stock';

    const newEntryOrderIds = new Set(
      (newTrade.executionData || [])
        .filter(e => e && e.type === 'entry' && e.orderId)
        .map(e => String(e.orderId))
    );

    for (const existing of existingTrades) {
      if (!existing?.id) continue;
      if (existing.exit_price != null && existing.exit_price !== '') continue;
      if (!this._tradeSymbolsMatch(newTrade, existing)) continue;

      if (newAccountIdentifier && existing.account_identifier && newAccountIdentifier !== existing.account_identifier) {
        continue;
      }

      const existingInstrumentType = existing.instrument_type || 'stock';
      if (existingInstrumentType !== newInstrumentType) continue;

      const existingQty = parseFloat(existing.quantity) || 0;
      if (Math.abs(existingQty - newQty) >= 0.001) continue;

      const existingEntryPrice = parseFloat(existing.entry_price) || 0;
      const entryPriceMatch = !newEntryPrice || !existingEntryPrice ||
        Math.abs(existingEntryPrice - newEntryPrice) / existingEntryPrice < 0.01;
      if (!entryPriceMatch) continue;

      let existingExecs = existing.executions || [];
      if (typeof existingExecs === 'string') {
        try { existingExecs = JSON.parse(existingExecs); } catch { existingExecs = []; }
      }
      const existingEntryOrderIds = new Set(
        (Array.isArray(existingExecs) ? existingExecs : [])
          .filter(e => e && e.type === 'entry' && e.orderId)
          .map(e => String(e.orderId))
      );
      const sharedEntryOrder = [...newEntryOrderIds].some(id => existingEntryOrderIds.has(id));
      const sameDate = this._extractDateString(existing.trade_date) === newTradeDate;

      if (sharedEntryOrder || sameDate) {
        return existing;
      }
    }

    return null;
  }


  _entryOrderIdsFromTrade(tradeLike) {
    const execs = tradeLike.executionData || tradeLike.executions || [];
    let list = execs;
    if (typeof list === 'string') {
      try { list = JSON.parse(list); } catch { list = []; }
    }
    return new Set(
      (Array.isArray(list) ? list : [])
        .filter(e => e && e.type === 'entry' && e.orderId)
        .map(e => String(e.orderId))
    );
  }

  /**
   * Remove open/partial remnant trades that share entry order IDs with a
   * newly closed Schwab trade (keeps keepTradeId). Prevents phantom opens
   * after incremental partial-exit syncs.
   */
  async removeSiblingTradesSharingEntryOrders(userId, closedTrade, keepTradeId, existingTrades) {
    const entryOrderIds = this._entryOrderIdsFromTrade(closedTrade);
    if (!entryOrderIds.size || !Array.isArray(existingTrades)) return 0;

    let removed = 0;
    for (let i = existingTrades.length - 1; i >= 0; i--) {
      const existing = existingTrades[i];
      if (!existing?.id || existing.id === keepTradeId) continue;
      if (!this._tradeSymbolsMatch(closedTrade, existing)) continue;

      const existingEntryIds = this._entryOrderIdsFromTrade(existing);
      const overlaps = [...entryOrderIds].some(id => existingEntryIds.has(id));
      if (!overlaps) continue;

      console.log(`[SCHWAB] Removing remnant trade ${existing.id} for ${closedTrade.symbol} (shared entry order with closed lot)`);
      try {
        await Trade.delete(existing.id, userId, { skipOptionGrouping: true });
        existingTrades.splice(i, 1);
        removed++;
      } catch (error) {
        console.warn(`[SCHWAB] Failed to remove remnant ${existing.id}:`, error.message);
      }
    }
    return removed;
  }

  /**
   * Check if trade is a duplicate
   * Matches against both broker-synced and CSV-imported trades
   */
  isDuplicateTrade(newTrade, existingTrades) {
    // Guard against invalid input
    if (!newTrade || !existingTrades || !Array.isArray(existingTrades)) {
      return false;
    }

    const symbol = newTrade.symbol?.toUpperCase();
    if (!symbol) return false;

    const newTradeDate = newTrade.tradeDate;
    const newQty = parseFloat(newTrade.quantity) || 0;
    const newEntryPrice = parseFloat(newTrade.entryPrice) || 0;
    const newExitPrice = parseFloat(newTrade.exitPrice) || 0;
    const newPnL = parseFloat(newTrade.pnl) || 0;
    const newInstrumentType = newTrade.instrumentType || 'stock';
    const newAccountIdentifier = newTrade.accountIdentifier || null;

    for (const existing of existingTrades) {
      if (!this._tradeSymbolsMatch(newTrade, existing)) continue;

      if (newAccountIdentifier && existing.account_identifier && newAccountIdentifier !== existing.account_identifier) {
        continue;
      }

      const existingInstrumentType = existing.instrument_type || 'stock';
      if (existingInstrumentType !== newInstrumentType) {
        continue;
      }

      if (newInstrumentType === 'option') {
        const optionTypeMatches = !newTrade.optionType || !existing.option_type || newTrade.optionType === existing.option_type;
        const strikeMatches = newTrade.strikePrice == null || existing.strike_price == null ||
          Math.abs(parseFloat(newTrade.strikePrice) - parseFloat(existing.strike_price)) < 0.0001;
        const expirationMatches = !newTrade.expirationDate || !existing.expiration_date ||
          this._extractDateString(newTrade.expirationDate) === this._extractDateString(existing.expiration_date);

        if (!optionTypeMatches || !strikeMatches || !expirationMatches) {
          continue;
        }
      }

      // 1. Check execution data match (by EXIT order ID + datetime) - most reliable
      // IMPORTANT: Only match on EXIT executions, not entry executions.
      // For partial exits (buy 15, sell 5, sell 10 later), all partial trades share
      // the same entry order ID but have different exit order IDs.
      // Matching on ANY execution would incorrectly flag partial exits as duplicates.
      if (newTrade.executionData?.length > 0 && existing.executions) {
        let existingExecs = existing.executions;
        if (typeof existingExecs === 'string') {
          try {
            existingExecs = JSON.parse(existingExecs);
          } catch {
            existingExecs = [];
          }
        }

        // Build EXIT "orderId|datetime" keys. A later full close can share some
        // exit fills with an earlier partial-close import — that must NOT count
        // as a duplicate of the full trade (otherwise the rest never imports).
        const newExitExecKeys = new Set(
          newTrade.executionData
            .filter(e => e.orderId && e.type === 'exit')
            .map(e => `${e.orderId}|${e.datetime}`)
        );
        const existingExitExecKeys = new Set(
          (Array.isArray(existingExecs) ? existingExecs : [])
            .filter(e => e && e.orderId && e.datetime && e.type === 'exit')
            .map(e => `${e.orderId}|${e.datetime}`)
        );

        if (newExitExecKeys.size > 0 && existingExitExecKeys.size > 0) {
          const newCoveredByExisting = [...newExitExecKeys].every(k => existingExitExecKeys.has(k));
          const existingQty = parseFloat(existing.quantity) || 0;
          const qtyMatches = Math.abs(existingQty - newQty) < 0.001;
          // Duplicate only when the incoming exits are fully covered by an
          // existing trade of the same size (re-sync). Partial ⊂ full is not.
          if (newCoveredByExisting && qtyMatches) {
            console.log(`[SCHWAB] Duplicate found by exit order ID + datetime: ${symbol}`);
            return true;
          }
        }
      }

      // 2. Match by date + quantity + prices (for CSV imports)
      // Open vs closed with the same entry must NOT count as duplicates — otherwise
      // a later sync that has the sell never upgrades the stale open lot.
      const existingDate = this._extractDateString(existing.trade_date);
      const newHasExit = newTrade.exitPrice != null && newTrade.exitPrice !== '';
      const existingHasExit = existing.exit_price != null && existing.exit_price !== '';

      if (existingDate === newTradeDate && newHasExit === existingHasExit) {
        const existingQty = parseFloat(existing.quantity);
        const existingEntryPrice = parseFloat(existing.entry_price);
        const existingExitPrice = parseFloat(existing.exit_price);

        // Quantity must match exactly
        if (Math.abs(existingQty - newQty) < 0.001) {
          // Entry price within 1%
          const entryPriceMatch = !newEntryPrice || !existingEntryPrice ||
            Math.abs(existingEntryPrice - newEntryPrice) / existingEntryPrice < 0.01;

          // Exit price within 1% when both are closed; both-open is always an exit match
          const exitPriceMatch = !newHasExit ||
            Math.abs(existingExitPrice - newExitPrice) / Math.max(Math.abs(existingExitPrice), 0.0001) < 0.01;

          if (entryPriceMatch && exitPriceMatch) {
            console.log(`[SCHWAB] Duplicate found by date/qty/price: ${symbol} on ${newTradeDate}`);
            return true;
          }
        }
      }

      // 3. Match by P&L if available (strong indicator for closed trades)
      if (newPnL && existing.pnl) {
        const existingDateForPnL = this._extractDateString(existing.trade_date);
        const existingPnL = parseFloat(existing.pnl);

        // Same date, same symbol, same P&L (within $0.01)
        if (existingDateForPnL === newTradeDate && Math.abs(existingPnL - newPnL) < 0.02) {
          console.log(`[SCHWAB] Duplicate found by P&L: ${symbol} on ${newTradeDate} ($${newPnL})`);
          return true;
        }
      }
    }

    return false;
  }

  _tradeSymbolsMatch(newTrade, existingTrade) {
    const newSymbol = newTrade.symbol?.toUpperCase();
    const existingSymbol = existingTrade.symbol?.toUpperCase();

    if (!newSymbol || !existingSymbol) return false;
    if (existingSymbol === newSymbol) return true;

    const newInstrumentType = newTrade.instrumentType || newTrade.instrument_type || 'stock';
    const existingInstrumentType = existingTrade.instrument_type || existingTrade.instrumentType || 'stock';
    if (newInstrumentType !== 'option' || existingInstrumentType !== 'option') {
      return false;
    }

    const parsedExisting = this._parseSchwabOptionSymbol(existingSymbol);
    const parsedNew = this._parseSchwabOptionSymbol(newTrade.matchingSymbol || newTrade.symbol);
    const existingUnderlying = existingTrade.underlying_symbol || existingTrade.underlyingSymbol || parsedExisting?.underlyingSymbol || existingSymbol;
    const newUnderlying = newTrade.underlyingSymbol || newTrade.underlying_symbol || parsedNew?.underlyingSymbol || newSymbol;

    return existingUnderlying?.toUpperCase() === newUnderlying?.toUpperCase();
  }

  getTradeDateRange(trades) {
    const dateStrings = trades
      .map(trade => this._extractDateString(trade.tradeDate || trade.exitTime || trade.entryTime))
      .filter(Boolean)
      .sort();

    if (dateStrings.length === 0) {
      return { minDate: null, maxDate: null };
    }

    return {
      minDate: dateStrings[0],
      maxDate: dateStrings[dateStrings.length - 1]
    };
  }

  /**
   * Validate Schwab OAuth setup
   */
  validateConfig() {
    const required = ['SCHWAB_CLIENT_ID', 'SCHWAB_CLIENT_SECRET', 'SCHWAB_REDIRECT_URI'];
    const missing = required.filter(key => !process.env[key]);

    if (missing.length > 0) {
      return {
        valid: false,
        message: `Missing Schwab configuration: ${missing.join(', ')}`
      };
    }

    return { valid: true };
  }
}

module.exports = new SchwabService();
