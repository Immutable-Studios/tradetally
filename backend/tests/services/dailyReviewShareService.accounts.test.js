const mockDb = { query: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/models/BrokerConnection', () => ({
  getExcludedAccountIdentifiers: jest.fn().mockResolvedValue([]),
  findByUserId: jest.fn().mockResolvedValue([])
}));

const BrokerConnection = require('../../src/models/BrokerConnection');
const DailyReviewShareService = require('../../src/services/dailyReviewShareService');

const USER = 'user-1';
const DAY = '2026-07-27';

function activeAccounts(...identifiers) {
  mockDb.query.mockResolvedValue({
    rows: identifiers.map(account_identifier => ({ account_identifier }))
  });
}

describe('listAccountsForDay', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.DAILY_REVIEW_ACCOUNTS;
    BrokerConnection.getExcludedAccountIdentifiers.mockResolvedValue([]);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    delete process.env.DAILY_REVIEW_ACCOUNTS;
  });

  describe('without an allowlist', () => {
    it('returns every account with activity, sorted', async () => {
      activeAccounts('****7790', '****5119');

      await expect(DailyReviewShareService.listAccountsForDay(USER, DAY))
        .resolves.toEqual(['****5119', '****7790']);
    });

    it('includes accounts holding an open position even with no fills that day', async () => {
      activeAccounts('****5119');

      await DailyReviewShareService.listAccountsForDay(USER, DAY);

      // The query deliberately ORs the day's trades with anything still open.
      expect(mockDb.query.mock.calls[0][0]).toContain('exit_price IS NULL');
    });

    it('drops Schwab-excluded accounts', async () => {
      activeAccounts('****5119', '****7790');
      BrokerConnection.getExcludedAccountIdentifiers.mockResolvedValue(['7790', '****7790']);

      await expect(DailyReviewShareService.listAccountsForDay(USER, DAY))
        .resolves.toEqual(['****5119']);
    });

    it('falls back to a single all-accounts review on a quiet day', async () => {
      // Better one "nothing happened" email than silence.
      activeAccounts();

      await expect(DailyReviewShareService.listAccountsForDay(USER, DAY)).resolves.toEqual([null]);
    });

    it('surfaces unassigned trades as their own bucket', async () => {
      activeAccounts('__unsorted__');

      await expect(DailyReviewShareService.listAccountsForDay(USER, DAY))
        .resolves.toEqual(['__unsorted__']);
    });

    it('still returns a review when the account query fails', async () => {
      mockDb.query.mockRejectedValue(new Error('db down'));

      await expect(DailyReviewShareService.listAccountsForDay(USER, DAY)).resolves.toEqual([null]);
    });

    it('survives a failing excluded-accounts lookup', async () => {
      activeAccounts('****5119');
      BrokerConnection.getExcludedAccountIdentifiers.mockRejectedValue(new Error('nope'));

      await expect(DailyReviewShareService.listAccountsForDay(USER, DAY))
        .resolves.toEqual(['****5119']);
    });
  });

  describe('with DAILY_REVIEW_ACCOUNTS set', () => {
    it('reviews only the allowlisted account', async () => {
      process.env.DAILY_REVIEW_ACCOUNTS = '****5119';
      activeAccounts('****5119', '****7790');

      await expect(DailyReviewShareService.listAccountsForDay(USER, DAY))
        .resolves.toEqual(['****5119']);
    });

    it('resolves an unmasked entry to the spelling stored on trades', async () => {
      // Configured as 5119 but stored as ****5119 — returning '5119' would
      // produce an account filter that matches no trades at all.
      process.env.DAILY_REVIEW_ACCOUNTS = '5119';
      activeAccounts('****5119', '****7790');

      await expect(DailyReviewShareService.listAccountsForDay(USER, DAY))
        .resolves.toEqual(['****5119']);
    });

    it('accepts several accounts and ignores surrounding whitespace', async () => {
      process.env.DAILY_REVIEW_ACCOUNTS = ' 5119 , 7790 ';
      activeAccounts('****5119', '****7790');

      await expect(DailyReviewShareService.listAccountsForDay(USER, DAY))
        .resolves.toEqual(['****5119', '****7790']);
    });

    it('keeps an allowlisted account with no activity, so the email still arrives', async () => {
      process.env.DAILY_REVIEW_ACCOUNTS = '5119';
      activeAccounts();

      await expect(DailyReviewShareService.listAccountsForDay(USER, DAY)).resolves.toEqual(['5119']);
    });

    it('ignores the exclusion list — an explicit allowlist is the stronger signal', async () => {
      process.env.DAILY_REVIEW_ACCOUNTS = '7790';
      activeAccounts('****5119', '****7790');
      BrokerConnection.getExcludedAccountIdentifiers.mockResolvedValue(['7790']);

      await expect(DailyReviewShareService.listAccountsForDay(USER, DAY))
        .resolves.toEqual(['****7790']);
    });

    it('treats a blank value as unset', async () => {
      process.env.DAILY_REVIEW_ACCOUNTS = '   ';
      activeAccounts('****5119', '****7790');

      await expect(DailyReviewShareService.listAccountsForDay(USER, DAY))
        .resolves.toEqual(['****5119', '****7790']);
    });

    it('still applies when the account query fails', async () => {
      process.env.DAILY_REVIEW_ACCOUNTS = '5119';
      mockDb.query.mockRejectedValue(new Error('db down'));

      await expect(DailyReviewShareService.listAccountsForDay(USER, DAY)).resolves.toEqual(['5119']);
    });
  });
});
