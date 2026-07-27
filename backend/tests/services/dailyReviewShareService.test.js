jest.mock('../../src/config/database', () => ({
  query: jest.fn()
}));
jest.mock('../../src/models/User', () => ({
  findById: jest.fn(),
  getSettings: jest.fn()
}));
jest.mock('../../src/models/DailyReviewShare', () => ({
  getOrCreate: jest.fn(),
  updateAccountSnapshot: jest.fn()
}));
jest.mock('../../src/services/accountBalanceService', () => ({
  captureAccountSnapshotForDay: jest.fn().mockResolvedValue(null)
}));
jest.mock('../../src/services/emailService', () => ({
  isConfigured: jest.fn(),
  sendDailyReviewEmail: jest.fn()
}));
jest.mock('../../src/services/tradeQueries', () => ({
  getAnalytics: jest.fn()
}));
jest.mock('../../src/models/BrokerConnection', () => ({
  findByUserId: jest.fn().mockResolvedValue([]),
  getExcludedAccountIdentifiers: jest.fn().mockResolvedValue([])
}));
jest.mock('../../src/services/brokerSync', () => ({
  syncConnection: jest.fn().mockResolvedValue({ imported: 0, duplicates: 0 })
}));

const db = require('../../src/config/database');
const User = require('../../src/models/User');
const DailyReviewShare = require('../../src/models/DailyReviewShare');
const EmailService = require('../../src/services/emailService');
const TradeQueries = require('../../src/services/tradeQueries');
const BrokerConnection = require('../../src/models/BrokerConnection');
const BrokerSyncService = require('../../src/services/brokerSync');
const AccountBalanceService = require('../../src/services/accountBalanceService');
const DailyReviewShareService = require('../../src/services/dailyReviewShareService');

const USER_ID = 'user-1';

function mockUser(overrides = {}) {
  return {
    id: USER_ID,
    email: 'trader@example.com',
    is_active: true,
    ...overrides
  };
}

function mockAnalytics(totalTrades = 0, totalPnL = 0) {
  return { summary: { totalTrades, totalPnL } };
}

describe('DailyReviewShareService.generateAndSendForUser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.DAILY_REVIEW_ACCOUNTS;
    EmailService.isConfigured.mockReturnValue(true);
    User.findById.mockResolvedValue(mockUser());
    User.getSettings.mockResolvedValue({});
    TradeQueries.getAnalytics.mockResolvedValue(mockAnalytics(3, 125.5));
    // No per-account activity -> the single all-accounts review.
    db.query.mockResolvedValue({ rows: [] });
    DailyReviewShare.getOrCreate.mockImplementation((userId, shareDate, opts = {}) => Promise.resolve({
      id: `share-${opts.accountIdentifier || 'all'}`,
      token: opts.accountIdentifier ? `tok-${opts.accountIdentifier}` : 'abc123',
      user_id: userId,
      share_date: shareDate,
      account_identifier: opts.accountIdentifier || null
    }));
  });

  afterAll(() => {
    delete process.env.DAILY_REVIEW_ACCOUNTS;
  });

  it('skips when email is not configured', async () => {
    EmailService.isConfigured.mockReturnValue(false);

    const result = await DailyReviewShareService.generateAndSendForUser(USER_ID, { shareDate: '2026-07-18' });

    expect(result).toBeNull();
    expect(EmailService.sendDailyReviewEmail).not.toHaveBeenCalled();
  });

  it('skips when the user has no email address', async () => {
    User.findById.mockResolvedValue(mockUser({ email: null }));

    const result = await DailyReviewShareService.generateAndSendForUser(USER_ID, { shareDate: '2026-07-18' });

    expect(result).toBeNull();
    expect(EmailService.sendDailyReviewEmail).not.toHaveBeenCalled();
  });

  it('skips when the user is inactive', async () => {
    User.findById.mockResolvedValue(mockUser({ is_active: false }));

    const result = await DailyReviewShareService.generateAndSendForUser(USER_ID, { shareDate: '2026-07-18' });

    expect(result).toBeNull();
    expect(EmailService.sendDailyReviewEmail).not.toHaveBeenCalled();
  });

  it('skips when the user opted out and force is not set', async () => {
    User.getSettings.mockResolvedValue({ daily_review_email_enabled: false });

    const result = await DailyReviewShareService.generateAndSendForUser(USER_ID, { shareDate: '2026-07-18' });

    expect(result).toBeNull();
    expect(EmailService.sendDailyReviewEmail).not.toHaveBeenCalled();
  });

  it('sends when the user opted out but force is set (explicit resend)', async () => {
    User.getSettings.mockResolvedValue({ daily_review_email_enabled: false });

    const result = await DailyReviewShareService.generateAndSendForUser(USER_ID, {
      shareDate: '2026-07-18',
      force: true
    });

    expect(result).not.toBeNull();
    expect(EmailService.sendDailyReviewEmail).toHaveBeenCalledTimes(1);
  });

  it('creates/reuses the share token and emails a link with day stats', async () => {
    const shares = await DailyReviewShareService.generateAndSendForUser(USER_ID, { shareDate: '2026-07-18' });

    expect(shares).toHaveLength(1);
    expect(shares[0].token).toBe('abc123');
    expect(DailyReviewShare.getOrCreate).toHaveBeenCalledWith(
      USER_ID,
      '2026-07-18',
      expect.objectContaining({ expiresAt: expect.any(Date) })
    );

    expect(EmailService.sendDailyReviewEmail).toHaveBeenCalledTimes(1);
    const [user, options] = EmailService.sendDailyReviewEmail.mock.calls[0];
    expect(user.id).toBe(USER_ID);
    expect(options.shareUrl).toContain('/daily/share/abc123');
    expect(options.tradeCount).toBe(3);
    expect(options.dayPnL).toBe(125.5);
    expect(options.recipients).toEqual(['trader@example.com']);
  });

  it('creates one review per account with activity, each scoped to its own book', async () => {
    db.query.mockResolvedValue({
      rows: [{ account_identifier: '****5119' }, { account_identifier: '****7790' }]
    });

    const shares = await DailyReviewShareService.generateAndSendForUser(USER_ID, { shareDate: '2026-07-18' });

    expect(shares).toHaveLength(2);
    expect(shares.map(s => s.account_identifier)).toEqual(['****5119', '****7790']);

    // Each review's stats query is filtered to that one account — this is the
    // mixing bug the split exists to fix.
    expect(TradeQueries.getAnalytics).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ accounts: ['****5119'] }));
    expect(TradeQueries.getAnalytics).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ accounts: ['****7790'] }));

    const labels = EmailService.sendDailyReviewEmail.mock.calls.map(([, o]) => o.accountLabel);
    expect(labels).toEqual(['****5119', '****7790']);

    // Distinct share links, so the two emails cannot show the same page.
    expect(new Set(EmailService.sendDailyReviewEmail.mock.calls.map(([, o]) => o.shareUrl)).size).toBe(2);
  });

  it('emails only the allowlisted account when DAILY_REVIEW_ACCOUNTS is set', async () => {
    process.env.DAILY_REVIEW_ACCOUNTS = '5119';
    db.query.mockResolvedValue({
      rows: [{ account_identifier: '****5119' }, { account_identifier: '****7790' }]
    });

    const shares = await DailyReviewShareService.generateAndSendForUser(USER_ID, { shareDate: '2026-07-18' });

    expect(shares).toHaveLength(1);
    // Configured as '5119', stored on trades as '****5119' — the review has to
    // use the stored spelling or its account filter would match nothing.
    expect(shares[0].account_identifier).toBe('****5119');
    expect(EmailService.sendDailyReviewEmail).toHaveBeenCalledTimes(1);
    expect(TradeQueries.getAnalytics).not.toHaveBeenCalledWith(
      USER_ID, expect.objectContaining({ accounts: ['****7790'] })
    );
  });

  it('keeps the per-account strip out of the user-level equity series', async () => {
    db.query.mockResolvedValue({ rows: [{ account_identifier: '****5119' }] });

    await DailyReviewShareService.generateAndSendForUser(USER_ID, { shareDate: '2026-07-18' });

    const calls = AccountBalanceService.captureAccountSnapshotForDay.mock.calls;
    // Exactly one aggregate call may persist; every account-scoped call must not.
    expect(calls.some(([, , opts]) => opts === undefined || opts?.persistEquity !== false)).toBe(true);
    for (const [, , opts] of calls) {
      if (opts?.accountIdentifier) expect(opts.persistEquity).toBe(false);
    }
  });

  it('still sends the remaining accounts when one fails', async () => {
    db.query.mockResolvedValue({
      rows: [{ account_identifier: '****5119' }, { account_identifier: '****7790' }]
    });
    DailyReviewShare.getOrCreate.mockImplementation((userId, shareDate, opts = {}) => {
      if (opts.accountIdentifier === '****5119') throw new Error('share failed');
      return Promise.resolve({ id: 'share-2', token: 'tok-2', account_identifier: opts.accountIdentifier });
    });

    const shares = await DailyReviewShareService.generateAndSendForUser(USER_ID, { shareDate: '2026-07-18' });

    expect(shares).toHaveLength(1);
    expect(shares[0].account_identifier).toBe('****7790');
  });

  describe('per-account dedupe', () => {
    // db.query serves both listAccountsForDay and recentlySentAccounts, so the
    // responses are matched to the query rather than queued in order.
    function respond({ accounts = [], sent = [] }) {
      db.query.mockImplementation((sql) => {
        if (sql.includes('email_log')) {
          return Promise.resolve({ rows: sent.map(account => ({ account })) });
        }
        return Promise.resolve({ rows: accounts.map(a => ({ account_identifier: a })) });
      });
    }

    it('skips an account whose review already went out', async () => {
      respond({ accounts: ['****5119', '****7790'], sent: ['****5119'] });

      const shares = await DailyReviewShareService.generateAndSendForUser(USER_ID, {
        shareDate: '2026-07-18',
        skipIfSentToday: true
      });

      expect(shares).toHaveLength(1);
      expect(shares[0].account_identifier).toBe('****7790');
    });

    it('still sends the account whose earlier attempt failed', async () => {
      // The bug this replaced: a user-level check saw ****5119 succeed and
      // skipped the user outright, so ****7790 never got a second chance.
      respond({ accounts: ['****5119', '****7790'], sent: ['****5119'] });

      const shares = await DailyReviewShareService.generateAndSendForUser(USER_ID, {
        shareDate: '2026-07-18',
        skipIfSentToday: true
      });

      const labels = EmailService.sendDailyReviewEmail.mock.calls.map(([, o]) => o.accountLabel);
      expect(labels).toEqual(['****7790']);
      expect(shares).toHaveLength(1);
    });

    it('sends nothing when every account is already covered', async () => {
      respond({ accounts: ['****5119'], sent: ['****5119'] });

      const shares = await DailyReviewShareService.generateAndSendForUser(USER_ID, {
        shareDate: '2026-07-18',
        skipIfSentToday: true
      });

      expect(shares).toBeNull();
      expect(EmailService.sendDailyReviewEmail).not.toHaveBeenCalled();
    });

    it('ignores previous sends when not deduping', async () => {
      respond({ accounts: ['****5119'], sent: ['****5119'] });

      const shares = await DailyReviewShareService.generateAndSendForUser(USER_ID, {
        shareDate: '2026-07-18',
        skipIfSentToday: false
      });

      expect(shares).toHaveLength(1);
    });

    it('matches the all-accounts review on its own sentinel', async () => {
      respond({ accounts: [], sent: ['__all__'] });

      const shares = await DailyReviewShareService.generateAndSendForUser(USER_ID, {
        shareDate: '2026-07-18',
        skipIfSentToday: true
      });

      expect(shares).toBeNull();
    });

    it('sends anyway when the dedupe lookup fails', async () => {
      // A duplicate email is a smaller problem than a missing one.
      db.query.mockImplementation((sql) => sql.includes('email_log')
        ? Promise.reject(new Error('db down'))
        : Promise.resolve({ rows: [{ account_identifier: '****5119' }] }));

      const shares = await DailyReviewShareService.generateAndSendForUser(USER_ID, {
        shareDate: '2026-07-18',
        skipIfSentToday: true
      });

      expect(shares).toHaveLength(1);
    });
  });

  it('routes the email to the configured recipients for the owner account', async () => {
    process.env.DAILY_REVIEW_OWNER_EMAIL = 'trader@example.com';
    process.env.DAILY_REVIEW_RECIPIENTS = 'personal@example.com, partner@example.com';

    try {
      await DailyReviewShareService.generateAndSendForUser(USER_ID, { shareDate: '2026-07-18' });

      const [, options] = EmailService.sendDailyReviewEmail.mock.calls[0];
      expect(options.recipients).toEqual(['personal@example.com', 'partner@example.com']);
    } finally {
      delete process.env.DAILY_REVIEW_OWNER_EMAIL;
      delete process.env.DAILY_REVIEW_RECIPIENTS;
    }
  });
});

describe('DailyReviewShareService.runDailyBatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    EmailService.isConfigured.mockReturnValue(true);
    User.getSettings.mockResolvedValue({});
    TradeQueries.getAnalytics.mockResolvedValue(mockAnalytics(0, null));
  });

  it('sends to eligible users and tallies sent/skipped/failed', async () => {
    db.query.mockResolvedValue({ rows: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }] });
    BrokerConnection.findByUserId.mockResolvedValue([
      { id: 'conn-1', brokerType: 'schwab', connectionStatus: 'active' }
    ]);

    User.findById.mockImplementation((id) => {
      if (id === 'u2') return Promise.resolve(null); // skipped: not found
      if (id === 'u3') return Promise.resolve(mockUser({ id: 'u3' }));
      return Promise.resolve(mockUser({ id }));
    });

    DailyReviewShare.getOrCreate.mockImplementation((userId) => {
      if (userId === 'u3') throw new Error('db exploded');
      return Promise.resolve({ id: `share-${userId}`, token: `tok-${userId}` });
    });

    const stats = await DailyReviewShareService.runDailyBatch();

    expect(stats.users).toBe(3);
    expect(stats.sent).toBe(1);
    expect(stats.skipped).toBe(1);
    expect(stats.failed).toBe(1);
    expect(BrokerSyncService.syncConnection).toHaveBeenCalledWith('conn-1', { syncType: 'scheduled' });
  });

  it('selects users without deduping at the user level', async () => {
    // Deduping here would skip a whole user because one of their accounts had
    // already sent, stranding any account whose send failed.
    db.query.mockResolvedValue({ rows: [] });

    await DailyReviewShareService.runDailyBatch();

    expect(db.query.mock.calls[0][0]).not.toContain('email_log');
  });

  it('passes the dedupe preference down to the per-account send', async () => {
    db.query.mockResolvedValue({ rows: [{ id: 'u1' }] });
    const spy = jest.spyOn(DailyReviewShareService, 'generateAndSendForUser').mockResolvedValue([{}]);

    await DailyReviewShareService.runDailyBatch();
    expect(spy).toHaveBeenCalledWith('u1', expect.objectContaining({ skipIfSentToday: true }));

    await DailyReviewShareService.runDailyBatch({ skipIfSentToday: false });
    expect(spy).toHaveBeenLastCalledWith('u1', expect.objectContaining({ skipIfSentToday: false }));

    spy.mockRestore();
  });
});
