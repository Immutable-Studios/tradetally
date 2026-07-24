const {
  resolveFuturesRoot,
  isKnownFuturesRoot,
  getFuturesPointValue,
  getFuturesContractExpiryDate,
  isFuturesContractExpired,
  getContinuousChartSymbolCandidates
} = require('../../src/utils/futuresUtils');

describe('resolveFuturesRoot', () => {
  it('accepts known bare roots', () => {
    expect(resolveFuturesRoot('MNQ')).toBe('MNQ');
    expect(resolveFuturesRoot('es')).toBe('ES');
    expect(resolveFuturesRoot('CL')).toBe('CL');
  });

  it('normalizes contract symbols to their root', () => {
    expect(resolveFuturesRoot('MNQM6')).toBe('MNQ');
    expect(resolveFuturesRoot('ESU25')).toBe('ES');
    expect(resolveFuturesRoot('M2KM6')).toBe('M2K');
  });

  it('rejects unknown symbols', () => {
    expect(resolveFuturesRoot('AAPL')).toBeNull();
    expect(resolveFuturesRoot('ZZTX5')).toBeNull(); // contract format, unknown root
    expect(resolveFuturesRoot('')).toBeNull();
    expect(resolveFuturesRoot(null)).toBeNull();
  });
});

describe('isKnownFuturesRoot', () => {
  it('matches the point-value table exactly', () => {
    expect(isKnownFuturesRoot('ES')).toBe(true);
    expect(isKnownFuturesRoot('mnq')).toBe(true);
    expect(isKnownFuturesRoot('SPY')).toBe(false);
    expect(isKnownFuturesRoot(null)).toBe(false);
  });
});

describe('getFuturesPointValue', () => {
  it('returns known point values and the default for unknowns', () => {
    expect(getFuturesPointValue('MNQ')).toBe(2);
    expect(getFuturesPointValue('ES')).toBe(50);
    expect(getFuturesPointValue('UNKNOWN')).toBe(50);
  });
});

describe('getContinuousChartSymbolCandidates', () => {
  it('maps micro contracts to /MES then /ES style continuous roots', () => {
    expect(getContinuousChartSymbolCandidates('MESU26')).toEqual([
      '/MES', '/ES', '!MES', '!ES', 'MES', 'ES'
    ]);
    expect(getContinuousChartSymbolCandidates('MNQU26')).toEqual([
      '/MNQ', '/NQ', '!MNQ', '!NQ', 'MNQ', 'NQ'
    ]);
  });

  it('maps full-size contracts without micro aliases', () => {
    expect(getContinuousChartSymbolCandidates('ESU26')).toEqual([
      '/ES', '!ES', 'ES'
    ]);
  });

  it('returns empty for equities', () => {
    expect(getContinuousChartSymbolCandidates('AAPL')).toEqual([]);
  });
});

describe('futures contract expiry', () => {
  it('uses the 3rd Friday of the contract month', () => {
    // March 2026: 1st is Sunday → 3rd Friday is March 20
    expect(getFuturesContractExpiryDate('MNQH26').toISOString().slice(0, 10)).toBe('2026-03-20');
    // June 2026: 1st is Monday → 3rd Friday is June 19
    expect(getFuturesContractExpiryDate('MNQM26').toISOString().slice(0, 10)).toBe('2026-06-19');
  });

  it('marks rolled months as expired and front months as live', () => {
    const asOf = new Date('2026-07-20T12:00:00Z');
    expect(isFuturesContractExpired('MNQH26', asOf)).toBe(true);
    expect(isFuturesContractExpired('MNQM26', asOf)).toBe(true);
    expect(isFuturesContractExpired('MNQU26', asOf)).toBe(false);
  });
});
