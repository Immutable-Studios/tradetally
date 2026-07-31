const {
  parseTradeFilters,
  parseTradeFiltersForRequest,
  tradeFilterProfiles
} = require('../../src/utils/tradeFilters');

describe('parseTradeFilters mentorMode', () => {
  test('parseTradeFiltersForRequest sets mentorMode for mentors', () => {
    const filters = parseTradeFiltersForRequest(
      { isMentor: true, query: { symbol: 'AAPL' } },
      tradeFilterProfiles.tradeList
    );
    expect(filters.mentorMode).toBe(true);
    expect(filters.symbol).toBe('AAPL');
  });

  test('parseTradeFiltersForRequest omits mentorMode for owners', () => {
    const filters = parseTradeFiltersForRequest(
      { isMentor: false, query: {} },
      tradeFilterProfiles.tradeList
    );
    expect(filters.mentorMode).toBeUndefined();
  });

  test('parseTradeFilters only sets mentorMode when option is true', () => {
    expect(parseTradeFilters({}, { mentorMode: true }).mentorMode).toBe(true);
    expect(parseTradeFilters({}, {}).mentorMode).toBeUndefined();
  });
});
