jest.mock('../../src/models/BrokerConnection', () => ({
  getExcludedAccountIdentifiers: jest.fn(async () => ['7790', '****7790'])
}));

const BrokerConnection = require('../../src/models/BrokerConnection');
const TradeQueries = require('../../src/services/tradeQueries');

describe('TradeQueries mentorMode account scoping', () => {
  test('owner All Accounts applies Schwab exclusions', async () => {
    const { whereClause, values } = await TradeQueries._buildWhereClause('owner-1', {});
    expect(whereClause).toContain('<> ALL(');
    expect(values).toEqual(expect.arrayContaining([['7790', '****7790']]));
    expect(BrokerConnection.getExcludedAccountIdentifiers).toHaveBeenCalledWith('owner-1');
  });

  test('mentor All Accounts skips Schwab exclusions and hides unshared accounts', async () => {
    BrokerConnection.getExcludedAccountIdentifiers.mockClear();
    const { whereClause, values } = await TradeQueries._buildWhereClause('owner-1', {
      mentorMode: true
    });
    expect(whereClause).toContain('shared_with_mentors = false');
    expect(whereClause).not.toContain('<> ALL(');
    expect(BrokerConnection.getExcludedAccountIdentifiers).not.toHaveBeenCalled();
    expect(values).toEqual(['owner-1']);
  });

  test('mentor explicit account filter still blocks unshared managed accounts', async () => {
    const { whereClause, values } = await TradeQueries._buildWhereClause('owner-1', {
      mentorMode: true,
      accounts: ['****5119']
    });
    expect(whereClause).toContain('t.account_identifier IN (');
    expect(whereClause).toContain('shared_with_mentors = false');
    expect(values).toContain('****5119');
  });
});
