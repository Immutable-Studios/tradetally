const axios = require('axios');
const cache = require('./cache');
const historicalPriceCache = require('./historicalPriceCache');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const TRADE_CHART_CONTEXT_DAYS_BEFORE = 180;
const TRADE_CHART_CONTEXT_DAYS_AFTER = 30;

function candleRangeCoversDate(candles, targetDate) {
  if (!Array.isArray(candles) || candles.length === 0 || Number.isNaN(targetDate.getTime())) {
    return false;
  }

  const targetDateKey = targetDate.toISOString().split('T')[0];
  const candleDateKeys = candles
    .map((candle) => new Date(Number(candle.time) * 1000))
    .filter((date) => !Number.isNaN(date.getTime()))
    .map((date) => date.toISOString().split('T')[0])
    .sort();

  if (candleDateKeys.length === 0) return false;
  return targetDateKey >= candleDateKeys[0] && targetDateKey <= candleDateKeys[candleDateKeys.length - 1];
}

class AlphaVantageClient {
  constructor() {
    this.apiKey = process.env.ALPHA_VANTAGE_API_KEY;
    this.baseURL = 'https://www.alphavantage.co/query';
    
    // Rate limiting: 25 calls per day, 5 calls per minute
    this.callTimestamps = [];
    this.dailyCalls = [];
  }

  isConfigured() {
    return !!this.apiKey;
  }

  async waitForRateLimit() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    
    // Clean up old timestamps
    this.callTimestamps = this.callTimestamps.filter(timestamp => timestamp > oneMinuteAgo);
    this.dailyCalls = this.dailyCalls.filter(timestamp => timestamp > oneDayAgo);
    
    // Check daily limit (25 calls per day for free tier)
    if (this.dailyCalls.length >= 25) {
      throw new Error('Alpha Vantage daily API limit reached (25 calls). Try again tomorrow.');
    }
    
    // Check minute limit (5 calls per minute)
    if (this.callTimestamps.length >= 5) {
      const oldestCall = this.callTimestamps[0];
      const waitTime = 60000 - (now - oldestCall) + 1000; // Add 1s buffer
      
      if (waitTime > 0) {
        console.log(`Alpha Vantage rate limit reached, waiting ${waitTime}ms`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
    
    // Record this call
    this.callTimestamps.push(now);
    this.dailyCalls.push(now);
  }

  async makeRequest(params) {
    if (!this.apiKey) {
      throw new Error('Alpha Vantage API key not configured');
    }

    // Apply rate limiting
    await this.waitForRateLimit();

    try {
      const response = await axios.get(this.baseURL, {
        params: {
          ...params,
          apikey: this.apiKey,
          datatype: 'json'
        },
        timeout: 10000
      });

      // Check for API errors
      if (response.data['Error Message']) {
        throw new Error(`Alpha Vantage API error: ${response.data['Error Message']}`);
      }

      if (response.data['Note']) {
        throw new Error(`Alpha Vantage API limit: ${response.data['Note']}`);
      }

      // Check for Information messages (often indicates API key issues or invalid parameters)
      if (response.data['Information']) {
        throw new Error(`Alpha Vantage API info: ${response.data['Information']}`);
      }

      // Log response keys for debugging if empty or unexpected
      const responseKeys = Object.keys(response.data || {});
      if (responseKeys.length === 0) {
        console.error('Alpha Vantage returned empty response');
        throw new Error('Alpha Vantage returned empty response');
      }

      console.log(`Alpha Vantage response keys: ${responseKeys.join(', ')}`);

      return response.data;
    } catch (error) {
      if (error.response) {
        const status = error.response.status;
        if (status === 503) {
          throw new Error('Alpha Vantage service is temporarily unavailable (503). Please try again later.');
        } else if (status === 429) {
          throw new Error('Alpha Vantage rate limit exceeded. Please try again in a few minutes.');
        } else if (status >= 500) {
          throw new Error(`Alpha Vantage server error (${status}). Please try again later.`);
        }
        throw new Error(`Alpha Vantage API error: ${status} - ${error.response.statusText}`);
      }
      // Handle timeout errors
      if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
        throw new Error('Alpha Vantage request timed out. The service may be experiencing high load or connectivity issues.');
      }
      throw error;
    }
  }

  // Note: TIME_SERIES_INTRADAY is an Alpha Vantage premium endpoint. Historical
  // months (via the `month` param, format YYYY-MM) require a premium key. The free
  // tier only returns the most recent trading days and is capped at 25 calls/day.
  async getIntradayData(symbol, interval = '5min', month = null) {
    const symbolUpper = symbol.toUpperCase();
    const cacheKey = month ? `${symbolUpper}_${interval}_${month}` : `${symbolUpper}_${interval}`;

    // Check cache first
    const cached = await cache.get('chart_intraday', cacheKey);
    if (cached) {
      console.log(`Returning cached intraday data for ${symbol}`);
      return cached;
    }

    try {
      const params = {
        function: 'TIME_SERIES_INTRADAY',
        symbol: symbol.toUpperCase(),
        interval: interval,
        outputsize: 'full' // Get full day's data (full month when `month` is set)
      };
      // Query a specific historical month (premium-only) when provided
      if (month) {
        params.month = month;
      }
      const data = await this.makeRequest(params);

      // Extract time series data
      const timeSeriesKey = `Time Series (${interval})`;
      const timeSeries = data[timeSeriesKey];

      if (!timeSeries) {
        // Log what was actually returned for debugging
        const availableKeys = Object.keys(data).join(', ');
        console.error(`Alpha Vantage response missing '${timeSeriesKey}' for ${symbol}. Available keys: ${availableKeys}`);
        throw new Error(`No intraday data available for ${symbol}. Response keys: ${availableKeys}`);
      }

      // Convert to array format for easier processing
      const candles = Object.entries(timeSeries).map(([time, values]) => ({
        time: new Date(time).getTime() / 1000, // Convert to Unix timestamp
        open: parseFloat(values['1. open']),
        high: parseFloat(values['2. high']),
        low: parseFloat(values['3. low']),
        close: parseFloat(values['4. close']),
        volume: parseInt(values['5. volume'])
      })).reverse(); // Reverse to get chronological order

      // Cache the result
      await cache.set('chart_intraday', cacheKey, candles);

      return candles;
    } catch (error) {
      console.error(`Failed to get intraday data for ${symbol}: ${error.message}`);
      throw error;
    }
  }

  async getDailyData(symbol, outputsize = 'compact') {
    const symbolUpper = symbol.toUpperCase();
    const cacheKey = `${symbolUpper}_${outputsize}`;
    
    // Check cache first
    const cached = await cache.get('chart_daily', cacheKey);
    if (cached) {
      console.log(`Returning cached daily data for ${symbol}`);
      return cached;
    }

    try {
      const data = await this.makeRequest({
        function: 'TIME_SERIES_DAILY',
        symbol: symbol.toUpperCase(),
        outputsize: outputsize // 'compact' = last 100 days, 'full' = 20+ years
      });

      // Extract time series data
      const timeSeries = data['Time Series (Daily)'];

      if (!timeSeries) {
        // Log what was actually returned for debugging
        const availableKeys = Object.keys(data).join(', ');
        console.error(`Alpha Vantage response missing 'Time Series (Daily)' for ${symbol}. Available keys: ${availableKeys}`);
        throw new Error(`No daily data available for ${symbol}. Response keys: ${availableKeys}`);
      }

      // Convert to array format
      const candles = Object.entries(timeSeries).map(([date, values]) => ({
        time: new Date(date).getTime() / 1000, // Convert to Unix timestamp
        open: parseFloat(values['1. open']),
        high: parseFloat(values['2. high']),
        low: parseFloat(values['3. low']),
        close: parseFloat(values['4. close']),
        volume: parseInt(values['5. volume'])
      })).reverse(); // Reverse to get chronological order

      // Cache the result
      await cache.set('chart_daily', cacheKey, candles);

      // Persist candles to DB for long-term caching
      try {
        await historicalPriceCache.insertCandles(symbol, candles, 'alphavantage');
      } catch (dbErr) {
        console.warn(`[PRICE-CACHE] Failed to persist daily candles for ${symbol}: ${dbErr.message}`);
      }

      return candles;
    } catch (error) {
      console.error(`Failed to get daily data for ${symbol}: ${error.message}`);
      throw error;
    }
  }

  // Get chart data for a trade.
  // options.resolution: 'D' (daily) or '5' (5-minute intraday). When omitted,
  // defaults to daily (the free-tier compatible behavior).
  // Note: 5-minute intraday for historical trade dates requires an Alpha Vantage
  // PREMIUM key (TIME_SERIES_INTRADAY with the `month` parameter). The free tier
  // only serves recent daily data (TIME_SERIES_DAILY 'compact' = ~100 days).
  async getTradeChartData(symbol, entryDate, exitDate = null, options = {}) {
    const resolution = options.resolution || 'D';
    const entryTime = new Date(entryDate);
    const exitTime = exitDate ? new Date(exitDate) : new Date();
    const tradeDuration = exitTime - entryTime;

    console.log(`Alpha Vantage chart request - Symbol: ${symbol}, Resolution: ${resolution}, Entry: ${entryTime.toISOString()}, Exit: ${exitTime.toISOString()}, Duration: ${Math.ceil(tradeDuration / ONE_DAY_MS)} days`);

    // 5-minute intraday (premium) — focus on the trade day(s) with extended hours
    if (resolution === '5') {
      try {
        const month = entryTime.toISOString().slice(0, 7); // YYYY-MM of the trade
        const rawCandles = await this.getIntradayData(symbol, '5min', month);

        // Keep an extended-hours window: from 04:00 ET on entry day to 20:00 ET on exit day
        const windowStart = Math.floor((new Date(entryTime.toISOString().split('T')[0] + 'T00:00:00.000Z').getTime() + 9 * 60 * 60 * 1000) / 1000);
        const windowEnd = Math.floor((new Date(exitTime.toISOString().split('T')[0] + 'T00:00:00.000Z').getTime() + 25 * 60 * 60 * 1000) / 1000);

        let filteredCandles = rawCandles.filter(c => c.time >= windowStart && c.time <= windowEnd);
        if (filteredCandles.length === 0) {
          console.warn(`No 5-min candles in trade window for ${symbol}, returning recent intraday data instead`);
          filteredCandles = rawCandles.slice(-78); // ~1 trading day of 5-min bars
        }

        return {
          type: 'intraday',
          interval: '5min',
          resolution: '5',
          candles: filteredCandles,
          source: 'alphavantage'
        };
      } catch (error) {
        console.error(`Error fetching Alpha Vantage 5-min chart data for ${symbol}:`, error);
        throw error;
      }
    }

    // Daily resolution (default)
    try {
      // Daily charts need enough history to show the setup that preceded the trade.
      // Alpha Vantage compact responses contain at most 100 bars, while the DB cache
      // can accumulate a wider range over time.
      const windowStart = entryTime.getTime() - TRADE_CHART_CONTEXT_DAYS_BEFORE * ONE_DAY_MS;
      const windowEnd = exitTime.getTime() + TRADE_CHART_CONTEXT_DAYS_AFTER * ONE_DAY_MS;
      const windowStartDate = new Date(windowStart).toISOString().split('T')[0];
      const windowEndDate = new Date(windowEnd).toISOString().split('T')[0];

      // Check persistent DB cache first (zero API calls if covered)
      try {
        const hasCached = await historicalPriceCache.hasRange(symbol, windowStartDate, windowEndDate);
        if (hasCached) {
          const cachedCandles = await historicalPriceCache.getRange(symbol, windowStartDate, windowEndDate);
          const coversTrade = candleRangeCoversDate(cachedCandles, entryTime) &&
            (!exitDate || candleRangeCoversDate(cachedCandles, exitTime));
          if (coversTrade) {
            console.log(`[PRICE-CACHE] Returning ${cachedCandles.length} cached candles from DB for ${symbol} (zero API calls)`);
            return {
              type: 'daily',
              interval: 'daily',
              resolution: 'D',
              candles: cachedCandles,
              source: 'alphavantage_cache'
            };
          }
        }
      } catch (dbErr) {
        console.warn(`[PRICE-CACHE] DB lookup failed for ${symbol}, falling through to API: ${dbErr.message}`);
      }

      // Choose output size based on how old the trade is. 'compact' (last ~100
      // trading days) is free-tier friendly; trades older than that need 'full'
      // (20+ years), which requires an Alpha Vantage premium key.
      const tradeAgeDays = (Date.now() - entryTime.getTime()) / ONE_DAY_MS;
      const outputsize = tradeAgeDays > 90 ? 'full' : 'compact';
      console.log(`Fetching daily data for ${symbol} (outputsize=${outputsize}, trade age ${Math.round(tradeAgeDays)} days)`);
      const rawCandles = await this.getDailyData(symbol, outputsize);

      // Never display a recent, unrelated window for an older trade. Doing so makes
      // correct provider prices appear to disagree with the recorded execution.
      const coversTrade = candleRangeCoversDate(rawCandles, entryTime) &&
        (!exitDate || candleRangeCoversDate(rawCandles, exitTime));
      if (!coversTrade) {
        throw new Error(
          `Alpha Vantage compact data for ${symbol} does not include the trade dates. ` +
          'Historical daily data requires a premium provider or previously cached candles.'
        );
      }

      const windowStartSeconds = Math.floor(windowStart / 1000);
      const windowEndSeconds = Math.floor(windowEnd / 1000);

      const filteredCandles = rawCandles.filter(candle => {
        return candle.time >= windowStartSeconds && candle.time <= windowEndSeconds;
      });

      console.log(`Filtered daily candles: ${filteredCandles.length} of ${rawCandles.length} candles within trade window`);

      if (filteredCandles.length === 0) {
        throw new Error(`No Alpha Vantage candles are available around the ${symbol} trade date.`);
      }

      return {
        type: 'daily',
        interval: 'daily',
        resolution: 'D',
        candles: filteredCandles,
        source: 'alphavantage'
      };
    } catch (error) {
      console.error(`Error fetching Alpha Vantage chart data for ${symbol}:`, error);
      throw error;
    }
  }

  // Get API usage stats
  async getUsageStats() {
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    // Get cache stats from the cache manager
    const cacheStats = await cache.getStats();

    return {
      dailyCallsUsed: this.dailyCalls.filter(t => t > oneDayAgo).length,
      dailyCallsRemaining: 25 - this.dailyCalls.filter(t => t > oneDayAgo).length,
      cacheSize: cacheStats.memoryEntries + cacheStats.databaseEntries,
      isConfigured: this.isConfigured()
    };
  }

  /**
   * Get dividend history for a stock
   * Uses the DIVIDENDS function from Alpha Vantage
   * @param {string} symbol - Stock symbol
   * @returns {Promise<Array>} Array of dividend objects with ex_dividend_date, amount, etc.
   */
  async getDividends(symbol) {
    const symbolUpper = symbol.toUpperCase();
    const cacheKey = `dividends_${symbolUpper}`;

    // Check cache first (24 hour TTL)
    const cached = await cache.get('av_dividends', cacheKey);
    if (cached) {
      console.log(`[AV-DIVIDENDS] Using cached dividend data for ${symbolUpper}`);
      return cached;
    }

    try {
      console.log(`[AV-DIVIDENDS] Fetching dividend history for ${symbolUpper}`);

      const data = await this.makeRequest({
        function: 'DIVIDENDS',
        symbol: symbolUpper
      });

      // Alpha Vantage returns: { data: [{ ex_dividend_date, declaration_date, record_date, payment_date, amount }] }
      const dividendData = data.data || [];

      // Normalize to common format matching Finnhub structure
      // Alpha Vantage may return "None" (Python-style null) for missing dates
      const sanitizeDate = (val) => (!val || val === 'None' || val === 'none') ? null : val;

      const dividends = dividendData.map(d => ({
        symbol: symbolUpper,
        date: sanitizeDate(d.ex_dividend_date), // ex-dividend date
        amount: parseFloat(d.amount) || 0,
        payDate: sanitizeDate(d.payment_date),
        recordDate: sanitizeDate(d.record_date),
        declarationDate: sanitizeDate(d.declaration_date),
        currency: 'USD' // Alpha Vantage doesn't return currency, assume USD
      }));

      if (dividends.length > 0) {
        console.log(`[AV-DIVIDENDS] Found ${dividends.length} dividends for ${symbolUpper}`);
        await cache.set('av_dividends', cacheKey, dividends);
      } else {
        console.log(`[AV-DIVIDENDS] No dividends found for ${symbolUpper}`);
        // Cache empty result for 24 hours
        await cache.set('av_dividends', cacheKey, []);
      }

      return dividends;
    } catch (error) {
      console.warn(`[AV-DIVIDENDS] Failed to get dividends for ${symbol}: ${error.message}`);
      // Return empty array instead of throwing to allow fallback logic
      return [];
    }
  }
}

module.exports = new AlphaVantageClient();
