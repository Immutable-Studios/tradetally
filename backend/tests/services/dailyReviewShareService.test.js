jest.mock('../../src/config/database', () => ({
  query: jest.fn()
}));
jest.mock('../../src/models/User', () => ({
  findById: jest.fn(),
  getSettings: jest.fn()
}));
jest.mock('../../src/models/DailyReviewShare', () => ({
  getOrCreate: jest.fn()
}));
jest.mock('../../src/services/emailService', () => ({
  isConfigured: jest.fn(),
  sendDailyReviewEmail: jest.fn()
}));
jest.mock('../../src/services/tradeQueries', () => ({
  getAnalytics: jest.fn()
}));
jest.mock('../../src/models/BrokerConnection', () => ({
  findByUserId: jest.fn().mockResolvedValue([])
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
    EmailService.isConfigured.mockReturnValue(true);
    User.findById.mockResolvedValue(mockUser());
    User.getSettings.mockResolvedValue({});
    TradeQueries.getAnalytics.mockResolvedValue(mockAnalytics(3, 125.5));
    DailyReviewShare.getOrCreate.mockResolvedValue({
      id: 'share-1',
      token: 'abc123',
      user_id: USER_ID,
      share_date: '2026-07-18'
    });
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

  it('skips when the user opted out and skipOptOutCheck is not set', async () => {
    User.getSettings.mockResolvedValue({ daily_review_email_enabled: false });

    const result = await DailyReviewShareService.generateAndSendForUser(USER_ID, { shareDate: '2026-07-18' });

    expect(result).toBeNull();
    expect(EmailService.sendDailyReviewEmail).not.toHaveBeenCalled();
  });

  it('sends when the user opted out but skipOptOutCheck is set (explicit resend)', async () => {
    User.getSettings.mockResolvedValue({ daily_review_email_enabled: false });

    const result = await DailyReviewShareService.generateAndSendForUser(USER_ID, {
      shareDate: '2026-07-18',
      skipOptOutCheck: true
    });

    expect(result).not.toBeNull();
    expect(EmailService.sendDailyReviewEmail).toHaveBeenCalledTimes(1);
  });

  it('creates/reuses the share token and emails a link with day stats', async () => {
    const share = await DailyReviewShareService.generateAndSendForUser(USER_ID, { shareDate: '2026-07-18' });

    expect(share.token).toBe('abc123');
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
});
