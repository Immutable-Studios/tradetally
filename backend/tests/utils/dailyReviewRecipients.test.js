const {
  resolveDailyReviewRecipients,
  parseRecipientList
} = require('../../src/utils/dailyReviewRecipients');

const OWNER = 'owner@example.com';

function user(email = OWNER) {
  return { id: 'user-1', email };
}

describe('parseRecipientList', () => {
  it('splits on commas, semicolons and whitespace', () => {
    expect(parseRecipientList('a@x.com, b@x.com;c@x.com d@x.com')).toEqual([
      'a@x.com', 'b@x.com', 'c@x.com', 'd@x.com'
    ]);
  });

  it('normalizes case and drops duplicates', () => {
    expect(parseRecipientList('A@X.com, a@x.com')).toEqual(['a@x.com']);
  });

  it('drops malformed entries', () => {
    expect(parseRecipientList('good@x.com, nope, also-bad@, @nope.com, x@y')).toEqual(['good@x.com']);
  });

  it('returns an empty list for blank or non-string input', () => {
    expect(parseRecipientList('')).toEqual([]);
    expect(parseRecipientList('   ')).toEqual([]);
    expect(parseRecipientList(undefined)).toEqual([]);
    expect(parseRecipientList(null)).toEqual([]);
    expect(parseRecipientList(42)).toEqual([]);
  });
});

describe('resolveDailyReviewRecipients', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DAILY_REVIEW_OWNER_EMAIL;
    delete process.env.DAILY_REVIEW_RECIPIENTS;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("defaults to the user's own address", () => {
    expect(resolveDailyReviewRecipients(user('trader@example.com'))).toEqual(['trader@example.com']);
  });

  it('returns an empty list when the user has no address', () => {
    expect(resolveDailyReviewRecipients(user(null))).toEqual([]);
    expect(resolveDailyReviewRecipients({})).toEqual([]);
    expect(resolveDailyReviewRecipients(null)).toEqual([]);
  });

  it('replaces the owner address with the configured recipients', () => {
    process.env.DAILY_REVIEW_OWNER_EMAIL = OWNER;
    process.env.DAILY_REVIEW_RECIPIENTS = 'personal@example.com, partner@example.com';

    expect(resolveDailyReviewRecipients(user(OWNER))).toEqual([
      'personal@example.com',
      'partner@example.com'
    ]);
  });

  it('matches the owner case-insensitively and ignores stray whitespace', () => {
    process.env.DAILY_REVIEW_OWNER_EMAIL = '  Owner@Example.COM ';
    process.env.DAILY_REVIEW_RECIPIENTS = 'personal@example.com';

    expect(resolveDailyReviewRecipients(user('OWNER@example.com'))).toEqual(['personal@example.com']);
  });

  it('leaves other users on their own address', () => {
    process.env.DAILY_REVIEW_OWNER_EMAIL = OWNER;
    process.env.DAILY_REVIEW_RECIPIENTS = 'personal@example.com';

    expect(resolveDailyReviewRecipients(user('someone-else@example.com')))
      .toEqual(['someone-else@example.com']);
  });

  it('ignores the override when no owner is configured, so nothing leaks globally', () => {
    process.env.DAILY_REVIEW_RECIPIENTS = 'personal@example.com';

    expect(resolveDailyReviewRecipients(user('trader@example.com'))).toEqual(['trader@example.com']);
  });

  it('falls back to the owner address when the recipient list is all junk', () => {
    process.env.DAILY_REVIEW_OWNER_EMAIL = OWNER;
    process.env.DAILY_REVIEW_RECIPIENTS = 'not-an-email, ,';

    expect(resolveDailyReviewRecipients(user(OWNER))).toEqual([OWNER]);
  });
});
