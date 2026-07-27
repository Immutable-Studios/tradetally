const mockDb = {
  query: jest.fn().mockResolvedValue({ rows: [] })
};

jest.mock('../../src/config/database', () => mockDb);

const emailService = require('../../src/services/emailService');

const USER = { id: 'user-1', email: 'owner@example.com' };
const OPTIONS = {
  dateLabel: 'Friday, July 17, 2026',
  shareUrl: 'https://tradetally.io/daily/share/tok123',
  tradeCount: 4,
  dayPnL: -82.5
};

describe('emailService.sendDailyReviewEmail recipients', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    process.env.RESEND_API_KEY = 'test-key';
    jest.spyOn(emailService, 'sendMail').mockResolvedValue({ messageId: 'mid' });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  function sentAddresses() {
    return emailService.sendMail.mock.calls.map(([opts]) => opts.to);
  }

  test("defaults to the user's own address", async () => {
    await emailService.sendDailyReviewEmail(USER, OPTIONS);

    expect(sentAddresses()).toEqual(['owner@example.com']);
  });

  test('sends a separate copy per recipient so addresses stay private', async () => {
    await emailService.sendDailyReviewEmail(USER, {
      ...OPTIONS,
      recipients: ['personal@example.com', 'partner@example.com']
    });

    expect(sentAddresses()).toEqual(['personal@example.com', 'partner@example.com']);
    for (const [opts] of emailService.sendMail.mock.calls) {
      expect(opts.cc).toBeUndefined();
      expect(opts.bcc).toBeUndefined();
      expect(opts.html).toContain('tok123');
    }
  });

  test('gives each copy a distinct Message-ID', async () => {
    await emailService.sendDailyReviewEmail(USER, {
      ...OPTIONS,
      recipients: ['personal@example.com', 'partner@example.com']
    });

    const ids = emailService.sendMail.mock.calls.map(([opts]) => opts.headers['Message-ID']);
    expect(new Set(ids).size).toBe(2);
  });

  test('logs one email_log row per recipient', async () => {
    await emailService.sendDailyReviewEmail(USER, {
      ...OPTIONS,
      recipients: ['personal@example.com', 'partner@example.com']
    });

    const logged = mockDb.query.mock.calls
      .filter(([sql]) => sql.includes('INSERT INTO email_log'))
      .map(([, params]) => params[0]);
    expect(logged).toEqual(['personal@example.com', 'partner@example.com']);
  });

  test('delivers to the remaining recipients when one address fails, then rethrows', async () => {
    emailService.sendMail
      .mockRejectedValueOnce(new Error('invalid recipient'))
      .mockResolvedValueOnce({ messageId: 'mid' });

    await expect(emailService.sendDailyReviewEmail(USER, {
      ...OPTIONS,
      recipients: ['bad@example.com', 'partner@example.com']
    })).rejects.toThrow('invalid recipient');

    expect(sentAddresses()).toEqual(['bad@example.com', 'partner@example.com']);

    const statuses = mockDb.query.mock.calls
      .filter(([sql]) => sql.includes('INSERT INTO email_log'))
      .map(([, params]) => params[5]);
    expect(statuses).toEqual(['failed', 'sent']);
  });

  test('skips the send entirely when there is no address at all', async () => {
    await emailService.sendDailyReviewEmail({ id: 'user-2', email: null }, OPTIONS);

    expect(emailService.sendMail).not.toHaveBeenCalled();
  });
});
