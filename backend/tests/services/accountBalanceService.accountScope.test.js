const mockDb = { query: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/models/BrokerConnection', () => ({
  getExcludedAccountIdentifiers: jest.fn().mockResolvedValue([])
}));
jest.mock('../../src/services/brokerSync/schwabService', () => ({
  getAccounts: jest.fn(),
  getWorkingStopOrders: jest.fn().mockResolvedValue([]),
  isSchwabAccountExcluded: jest.fn().mockReturnValue(false),
  getExcludedSchwabAccountLast4s: jest.fn().mockReturnValue([])
}));
jest.mock('../../src/utils/timezone', () => ({
  getUserTimezone: jest.fn().mockResolvedValue('America/Los_Angeles'),
  getDateInTimezone: jest.fn()
}));

const {
  computeTradingDayPl,
  resolveEquityForDay,
  computeOpenHeat
} = require('../../src/services/accountBalanceService');

const USER = 'user-1';

function sqlCalls() {
  return mockDb.query.mock.calls.map(([sql, params]) => ({ sql, params }));
}

function findCall(fragment) {
  return sqlCalls().find(c => c.sql.includes(fragment));
}

describe('realized day P&L account scoping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.query.mockResolvedValue({ rows: [{ realized: 0 }] });
  });

  it('restricts realized P&L to the requested account', async () => {
    await computeTradingDayPl(USER, '2026-07-27', { accountIdentifier: '****5119' });

    const call = findCall('SUM(pnl)');
    expect(call.sql).toContain('RIGHT(REGEXP_REPLACE');
    // Compared on last four digits, so '5119' and '****5119' both work.
    expect(call.params).toContain('5119');
  });

  it('sums every account when none is requested', async () => {
    await computeTradingDayPl(USER, '2026-07-27', {});

    const call = findCall('SUM(pnl)');
    expect(call.sql).not.toContain('RIGHT(REGEXP_REPLACE');
  });

  it('accepts an unmasked account identifier', async () => {
    await computeTradingDayPl(USER, '2026-07-27', { accountIdentifier: '5119' });

    expect(findCall('SUM(pnl)').params).toContain('5119');
  });

  it('scopes unassigned trades with a null/empty test rather than digits', async () => {
    await computeTradingDayPl(USER, '2026-07-27', { accountIdentifier: '__unsorted__' });

    const call = findCall('SUM(pnl)');
    expect(call.sql).toContain("account_identifier IS NULL OR account_identifier = ''");
    expect(call.sql).not.toContain('RIGHT(REGEXP_REPLACE');
  });
});

describe('open heat account scoping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.query.mockResolvedValue({ rows: [] });
  });

  it('counts only the requested account\'s open lots', async () => {
    await computeOpenHeat(USER, { accountIdentifier: '****7790' });

    const call = findCall('exit_price IS NULL');
    expect(call.sql).toContain('RIGHT(REGEXP_REPLACE');
    expect(call.params).toContain('7790');
  });

  it('counts every account when none is requested', async () => {
    await computeOpenHeat(USER, {});

    expect(findCall('exit_price IS NULL').sql).not.toContain('RIGHT(REGEXP_REPLACE');
  });
});

describe('resolveEquityForDay fallbacks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('refuses the user-level fallback for an account-scoped caller', async () => {
    // equity_snapshots and user_settings.account_equity hold combined equity.
    // Handing that back as one account's denominator would understate every
    // "% of equity" on the page, so it must return nothing instead.
    mockDb.query.mockResolvedValue({ rows: [{ equity_amount: 1000000 }] });

    const result = await resolveEquityForDay(USER, '2026-07-27', { accountIdentifier: '****5119' });

    expect(result).toEqual({ equity: null, strip: null });
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('still uses the snapshot fallback when unscoped', async () => {
    mockDb.query.mockResolvedValue({ rows: [{ equity_amount: 1000000 }] });

    const result = await resolveEquityForDay(USER, '2026-07-27', {});

    expect(result.equity).toBe(1000000);
  });

  it('falls back to user_settings equity when no snapshot exists', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ account_equity: 250000 }] });

    const result = await resolveEquityForDay(USER, '2026-07-27', {});

    expect(result.equity).toBe(250000);
  });
});
