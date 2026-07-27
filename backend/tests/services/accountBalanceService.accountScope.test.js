const mockDb = { query: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/models/BrokerConnection', () => ({
  getExcludedAccountIdentifiers: jest.fn().mockResolvedValue([]),
  findByUserId: jest.fn().mockResolvedValue([]),
  findById: jest.fn().mockResolvedValue(null)
}));
jest.mock('../../src/services/brokerSync/schwabService', () => ({
  getAccounts: jest.fn(),
  getWorkingStopOrders: jest.fn().mockResolvedValue([]),
  isSchwabAccountExcluded: jest.fn().mockReturnValue(false),
  getExcludedSchwabAccountLast4s: jest.fn().mockReturnValue([]),
  ensureValidToken: jest.fn().mockResolvedValue({ accessToken: 'tok', needsReauth: false })
}));
jest.mock('../../src/utils/timezone', () => ({
  getUserTimezone: jest.fn().mockResolvedValue('America/Los_Angeles'),
  getDateInTimezone: jest.fn()
}));

const schwabService = require('../../src/services/brokerSync/schwabService');
const BrokerConnection = require('../../src/models/BrokerConnection');
const {
  computeTradingDayPl,
  resolveEquityForDay,
  computeOpenHeat,
  captureAccountSnapshotForDay
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

describe('captureAccountSnapshotForDay balances', () => {
  // The reported bug in miniature: a single-account review showing Net Liq for
  // every account added together.
  function schwabAccount(number, netLiq, sodNetLiq) {
    return {
      securitiesAccount: {
        accountNumber: number,
        type: 'MARGIN',
        currentBalances: { liquidationValue: netLiq, cashBalance: 0 },
        initialBalances: { liquidationValue: sodNetLiq, equity: sodNetLiq },
        positions: []
      }
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.query.mockResolvedValue({ rows: [] });
    BrokerConnection.findByUserId.mockResolvedValue([
      { id: 'conn-1', brokerType: 'schwab', connectionStatus: 'active' }
    ]);
    BrokerConnection.findById.mockResolvedValue({ id: 'conn-1' });
    schwabService.getAccounts.mockResolvedValue([
      schwabAccount('12345119', 1030685.22, 1028759.92),
      schwabAccount('99997790', 169991.59, 171044.78)
    ]);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('sums every account when unscoped', async () => {
    const strip = await captureAccountSnapshotForDay(USER, '2026-07-27', { persistEquity: false });

    expect(strip.netLiq).toBeCloseTo(1200676.81, 2);
  });

  it('reports only the requested account', async () => {
    const strip = await captureAccountSnapshotForDay(USER, '2026-07-27', {
      accountIdentifier: '****5119', persistEquity: false
    });

    expect(strip.netLiq).toBe(1030685.22);
    expect(strip.equityForPct).toBe(1028759.92);
  });

  it('matches an account written without the mask', async () => {
    const strip = await captureAccountSnapshotForDay(USER, '2026-07-27', {
      accountIdentifier: '7790', persistEquity: false
    });

    expect(strip.netLiq).toBe(169991.59);
  });

  it('returns null when the requested account is not on the payload', async () => {
    const strip = await captureAccountSnapshotForDay(USER, '2026-07-27', {
      accountIdentifier: '****0000', persistEquity: false
    });

    expect(strip).toBeNull();
  });

  it('skips accounts Schwab has excluded', async () => {
    schwabService.isSchwabAccountExcluded.mockImplementation((masked) => masked === '****7790');

    const strip = await captureAccountSnapshotForDay(USER, '2026-07-27', { persistEquity: false });

    expect(strip.netLiq).toBe(1030685.22);
  });

  it('does not write the equity series when persistEquity is false', async () => {
    await captureAccountSnapshotForDay(USER, '2026-07-27', {
      accountIdentifier: '****5119', persistEquity: false
    });

    const writes = mockDb.query.mock.calls.filter(([sql]) =>
      /INSERT INTO equity_snapshots|UPDATE user_settings/i.test(sql));
    expect(writes).toHaveLength(0);
  });

  it('writes the equity series for the unscoped aggregate', async () => {
    await captureAccountSnapshotForDay(USER, '2026-07-27');

    const writes = mockDb.query.mock.calls.filter(([sql]) =>
      /equity_snapshots|user_settings/i.test(sql));
    expect(writes.length).toBeGreaterThan(0);
  });

  it('returns null when there is no active Schwab connection', async () => {
    BrokerConnection.findByUserId.mockResolvedValue([]);

    await expect(captureAccountSnapshotForDay(USER, '2026-07-27', { persistEquity: false }))
      .resolves.toBeNull();
  });

  it('returns null when the token needs reauth', async () => {
    schwabService.ensureValidToken.mockResolvedValue({ accessToken: null, needsReauth: true });

    await expect(captureAccountSnapshotForDay(USER, '2026-07-27', { persistEquity: false }))
      .resolves.toBeNull();
  });
});
