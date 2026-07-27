jest.mock('axios');
jest.mock('../../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../../src/services/brokerSync/encryptionService', () => ({
  decrypt: jest.fn((v) => v)
}));

const schwabMarketData = require('../../src/utils/schwabMarketData');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('chartSymbolCandidates', () => {
  it('maps a dated futures contract to its continuous roots first', () => {
    // Schwab has no pricehistory for MNQU26 itself, so the micro root and then
    // the full-size root have to be tried before it.
    const candidates = schwabMarketData.chartSymbolCandidates('MNQU26');

    expect(candidates[0]).toBe('/MNQ');
    expect(candidates).toContain('/NQ');
    expect(candidates.indexOf('/MNQ')).toBeLessThan(candidates.indexOf('MNQU26'));
    expect(candidates).toContain('MNQU26');
  });

  it('handles a leading slash and lowercase input', () => {
    expect(schwabMarketData.chartSymbolCandidates('/mnqu26')[0]).toBe('/MNQ');
  });

  it('maps micro S&P to /MES then /ES', () => {
    const candidates = schwabMarketData.chartSymbolCandidates('MESU26');
    expect(candidates.indexOf('/MES')).toBeLessThan(candidates.indexOf('/ES'));
  });

  it('leaves equities untouched', () => {
    expect(schwabMarketData.chartSymbolCandidates('AAPL')).toEqual(['AAPL']);
  });

  it('returns nothing for an empty symbol', () => {
    expect(schwabMarketData.chartSymbolCandidates('')).toEqual([]);
  });
});

describe('getCandlesWithSymbol', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('falls through to the continuous root when the dated contract has none', async () => {
    const rows = [{ time: 1, open: 1, high: 2, low: 0, close: 1, volume: 10 }];
    const fetch = jest.spyOn(schwabMarketData, 'fetchCandlesForSymbol')
      .mockImplementation(async (sym) => (sym === '/MNQ' ? rows : null));

    const result = await schwabMarketData.getCandlesWithSymbol('MNQU26', '5', 0, 1);

    expect(result.chartSymbol).toBe('/MNQ');
    expect(result.candles).toBe(rows);
    expect(fetch).toHaveBeenCalledWith('/MNQ', '5', 0, 1);
  });

  it('reports null when no candidate has data', async () => {
    jest.spyOn(schwabMarketData, 'fetchCandlesForSymbol').mockResolvedValue(null);

    const result = await schwabMarketData.getCandlesWithSymbol('MNQU26', '5', 0, 1);

    expect(result).toEqual({ candles: null, chartSymbol: null });
  });

  it('getCandles keeps returning a bare array for existing callers', async () => {
    const rows = [{ time: 1, open: 1, high: 2, low: 0, close: 1, volume: 10 }];
    jest.spyOn(schwabMarketData, 'fetchCandlesForSymbol').mockResolvedValue(rows);

    await expect(schwabMarketData.getCandles('AAPL', 'D', 0, 1)).resolves.toBe(rows);
  });
});

describe('getTradeChartData intraday window', () => {
  const rows = [{ time: 1, open: 1, high: 2, low: 0, close: 1, volume: 10 }];

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  async function windowFor(entryIso, exitIso) {
    let captured;
    jest.spyOn(schwabMarketData, 'getCandlesWithSymbol')
      .mockImplementation(async (symbol, resolution, from, to) => {
        captured = { from: from * 1000, to: to * 1000 };
        return { candles: rows, chartSymbol: symbol };
      });

    await schwabMarketData.getTradeChartData('MNQU26', entryIso, exitIso, { resolution: '5' });
    return captured;
  }

  it('starts on the prior day and runs through the whole execution day', async () => {
    // Wednesday 2026-07-29.
    const { from, to } = await windowFor('2026-07-29T14:30:00.000Z', '2026-07-29T18:00:00.000Z');

    const entryMidnight = Date.parse('2026-07-29T00:00:00.000Z');
    expect(from).toBe(entryMidnight - DAY + 9 * HOUR);
    // Through ~20:00 ET on the execution day, i.e. 01:00 UTC the next day.
    expect(to).toBe(entryMidnight + 25 * HOUR);
  });

  it('reaches back to Friday for a Monday trade rather than an empty Sunday', async () => {
    // Monday 2026-07-27 -> Friday 2026-07-24.
    const { from } = await windowFor('2026-07-27T14:30:00.000Z', '2026-07-27T18:00:00.000Z');

    expect(from).toBe(Date.parse('2026-07-24T00:00:00.000Z') + 9 * HOUR);
  });

  it('surfaces the symbol actually plotted', async () => {
    jest.spyOn(schwabMarketData, 'getCandlesWithSymbol')
      .mockResolvedValue({ candles: rows, chartSymbol: '/MNQ' });

    const data = await schwabMarketData.getTradeChartData('MNQU26', '2026-07-29T14:30:00.000Z', null, { resolution: '5' });

    expect(data.chartSymbol).toBe('/MNQ');
    expect(data.source).toBe('schwab');
  });

  it('leaves the daily window at ~90 days of context', async () => {
    let captured;
    jest.spyOn(schwabMarketData, 'getCandlesWithSymbol')
      .mockImplementation(async (symbol, resolution, from) => {
        captured = from * 1000;
        return { candles: rows, chartSymbol: symbol };
      });

    await schwabMarketData.getTradeChartData('AAPL', '2026-07-29T14:30:00.000Z', null, { resolution: 'D' });

    expect(captured).toBe(Date.parse('2026-07-29T00:00:00.000Z') - 90 * DAY);
  });
});
