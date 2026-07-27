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

  test('a partial failure does not fail the review — the delivered copy still counts', async () => {
    // The realistic case: an extra recipient the mail provider rejects while
    // the primary inbox is fine. Throwing here marked the whole account review
    // failed even though the review had landed.
    emailService.sendMail
      .mockRejectedValueOnce(new Error('invalid recipient'))
      .mockResolvedValueOnce({ messageId: 'mid' });

    const result = await emailService.sendDailyReviewEmail(USER, {
      ...OPTIONS,
      recipients: ['bad@example.com', 'partner@example.com']
    });

    expect(result).toEqual({ sent: 1, failed: 1 });
    expect(sentAddresses()).toEqual(['bad@example.com', 'partner@example.com']);

    const statuses = mockDb.query.mock.calls
      .filter(([sql]) => sql.includes('INSERT INTO email_log'))
      .map(([, params]) => params[5]);
    expect(statuses).toEqual(['failed', 'sent']);
  });

  test('throws only when every recipient fails', async () => {
    emailService.sendMail.mockRejectedValue(new Error('mailer down'));

    await expect(emailService.sendDailyReviewEmail(USER, {
      ...OPTIONS,
      recipients: ['a@example.com', 'b@example.com']
    })).rejects.toThrow('mailer down');
  });

  test('names the account in the subject and body so two reviews are distinguishable', async () => {
    await emailService.sendDailyReviewEmail(USER, { ...OPTIONS, accountLabel: '****5119' });

    const [opts] = emailService.sendMail.mock.calls[0];
    expect(opts.subject).toContain('****5119');
    expect(opts.html).toContain('****5119');
    expect(opts.text).toContain('****5119');
  });

  test('omits the account chrome when there is no account', async () => {
    await emailService.sendDailyReviewEmail(USER, OPTIONS);

    const [opts] = emailService.sendMail.mock.calls[0];
    expect(opts.subject).toBe(`Daily review - ${OPTIONS.dateLabel}`);
    expect(opts.html).not.toContain('Account ');
  });

  test('skips the send entirely when there is no address at all', async () => {
    await emailService.sendDailyReviewEmail({ id: 'user-2', email: null }, OPTIONS);

    expect(emailService.sendMail).not.toHaveBeenCalled();
  });
});
