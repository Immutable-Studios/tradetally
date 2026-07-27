jest.mock('axios');
jest.mock('../../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../../src/services/brokerSync/encryptionService', () => ({ decrypt: jest.fn((v) => v) }));

const axios = require('axios');
const schwabMarketData = require('../../src/utils/schwabMarketData');

const CANDLES = [
  { datetime: 1790000000000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
  { datetime: 1790000300000, open: 1.5, high: 2.5, low: 1, close: 2, volume: 200 }
];

function params() {
  return axios.get.mock.calls[0][1].params;
}

describe('fetchCandlesForSymbol', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(schwabMarketData, 'getActiveConnection').mockResolvedValue({ id: 'conn-1' });
    jest.spyOn(schwabMarketData, 'ensureValidToken')
      .mockResolvedValue({ accessToken: 'tok', needsReauth: false });
    // Reset, not clear: params() reads call [0], so leftovers from a previous
    // test would be inspected instead of this one's.
    axios.get.mockReset();
    axios.get.mockResolvedValue({ data: { candles: CANDLES } });
  });

  it('maps candles into the provider-neutral shape, seconds not millis', async () => {
    const rows = await schwabMarketData.fetchCandlesForSymbol('AAPL', '5', 1789990000, 1790010000);

    expect(rows).toEqual([
      { time: 1790000000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
      { time: 1790000300, open: 1.5, high: 2.5, low: 1, close: 2, volume: 200 }
    ]);
  });

  it('upper-cases the symbol and sends millisecond bounds', async () => {
    await schwabMarketData.fetchCandlesForSymbol('aapl', '5', 1789990000, 1790010000);

    expect(params().symbol).toBe('AAPL');
    expect(params().startDate).toBe(1789990000 * 1000);
    expect(params().endDate).toBe(1790010000 * 1000);
  });

  it.each([
    ['1', 'minute', 1],
    ['5', 'minute', 5],
    ['15', 'minute', 15],
    ['30', 'minute', 30]
  ])('maps resolution %s to %s/%s', async (resolution, frequencyType, frequency) => {
    await schwabMarketData.fetchCandlesForSymbol('AAPL', resolution, 0, 1);

    expect(params().frequencyType).toBe(frequencyType);
    expect(params().frequency).toBe(frequency);
  });

  it('maps D to a daily frequency over a yearly period', async () => {
    await schwabMarketData.fetchCandlesForSymbol('AAPL', 'D', 0, 1);

    expect(params().frequencyType).toBe('daily');
    expect(params().periodType).toBe('year');
  });

  it('falls back to daily for an unknown resolution', async () => {
    await schwabMarketData.fetchCandlesForSymbol('AAPL', 'nonsense', 0, 1);

    expect(params().frequencyType).toBe('daily');
  });

  it('returns null rather than an empty array when Schwab has no series', async () => {
    // getCandlesWithSymbol relies on falsy-or-empty to try the next candidate.
    axios.get.mockResolvedValue({ data: { candles: [] } });

    await expect(schwabMarketData.fetchCandlesForSymbol('MNQU26', '5', 0, 1)).resolves.toBeNull();
  });

  it('swallows request errors so callers can fall back to another provider', async () => {
    axios.get.mockRejectedValue(new Error('403 forbidden'));

    await expect(schwabMarketData.fetchCandlesForSymbol('AAPL', '5', 0, 1)).resolves.toBeNull();
  });

  it('returns null with no Schwab connection', async () => {
    schwabMarketData.getActiveConnection.mockResolvedValue(null);

    await expect(schwabMarketData.fetchCandlesForSymbol('AAPL', '5', 0, 1)).resolves.toBeNull();
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('returns null when the token needs reauth', async () => {
    schwabMarketData.ensureValidToken.mockResolvedValue({ accessToken: null, needsReauth: true });

    await expect(schwabMarketData.fetchCandlesForSymbol('AAPL', '5', 0, 1)).resolves.toBeNull();
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('sends the bearer token', async () => {
    await schwabMarketData.fetchCandlesForSymbol('AAPL', '5', 0, 1);

    expect(axios.get.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
  });
});

describe('quoteSymbolCandidates', () => {
  it('tries the dated futures contract before the continuous roots', () => {
    // The inverse of the chart case: a live quote for the contract actually
    // held is the accurate one, and Schwab does serve quotes for it.
    const candidates = schwabMarketData.quoteSymbolCandidates('MNQU26');

    expect(candidates[0]).toBe('MNQU26');
    expect(candidates).toContain('/MNQ');
    expect(candidates.indexOf('MNQU26')).toBeLessThan(candidates.indexOf('/MNQ'));
  });

  it('offers the slash form for a plain symbol', () => {
    expect(schwabMarketData.quoteSymbolCandidates('AAPL')).toEqual(['AAPL', '/AAPL']);
  });

  it('returns nothing for an empty symbol', () => {
    expect(schwabMarketData.quoteSymbolCandidates('')).toEqual([]);
    expect(schwabMarketData.quoteSymbolCandidates(null)).toEqual([]);
  });
});
