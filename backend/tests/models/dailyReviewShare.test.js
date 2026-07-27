const mockDb = { query: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);

const DailyReviewShare = require('../../src/models/DailyReviewShare');

const USER = 'user-1';
const DAY = '2026-07-27';

function lastCall() {
  const calls = mockDb.query.mock.calls;
  return { sql: calls[calls.length - 1][0], params: calls[calls.length - 1][1] };
}

describe('generateToken', () => {
  it('produces a 64-char hex token', () => {
    expect(DailyReviewShare.generateToken()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not repeat', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => DailyReviewShare.generateToken()));
    expect(tokens.size).toBe(50);
  });
});

describe('findByUserAndDate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.query.mockResolvedValue({ rows: [] });
  });

  it('matches a null account with IS-NULL semantics, not = NULL', () => {
    // `account_identifier = NULL` is never true, so an all-accounts share
    // would be invisible and re-minted on every run.
    DailyReviewShare.findByUserAndDate(USER, DAY, null);

    expect(lastCall().sql).toContain("COALESCE(account_identifier, '') = COALESCE($3::text, '')");
    expect(lastCall().params).toEqual([USER, DAY, null]);
  });

  it('passes the account through when scoped', () => {
    DailyReviewShare.findByUserAndDate(USER, DAY, '****5119');

    expect(lastCall().params).toEqual([USER, DAY, '****5119']);
  });

  it('defaults to the all-accounts share', () => {
    DailyReviewShare.findByUserAndDate(USER, DAY);

    expect(lastCall().params[2]).toBeNull();
  });

  it('returns null when nothing matches', async () => {
    await expect(DailyReviewShare.findByUserAndDate(USER, DAY)).resolves.toBeNull();
  });
});

describe('findAllByUserAndDate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.query.mockResolvedValue({ rows: [{ id: 'a' }, { id: 'b' }] });
  });

  it('returns every account share for the day', async () => {
    await expect(DailyReviewShare.findAllByUserAndDate(USER, DAY)).resolves.toHaveLength(2);
    expect(lastCall().params).toEqual([USER, DAY]);
  });
});

describe('getOrCreate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reuses an existing share rather than minting a new token', async () => {
    // Re-minting would invalidate a link that has already been emailed.
    const existing = { id: 's1', token: 'existing', account_identifier: '****5119' };
    mockDb.query.mockResolvedValueOnce({ rows: [existing] });

    const share = await DailyReviewShare.getOrCreate(USER, DAY, { accountIdentifier: '****5119' });

    expect(share).toBe(existing);
    expect(mockDb.query).toHaveBeenCalledTimes(1); // lookup only, no insert
  });

  it('creates one scoped to the account', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 's2', account_identifier: '****7790' }] });

    const share = await DailyReviewShare.getOrCreate(USER, DAY, {
      accountIdentifier: '****7790',
      expiresAt: new Date('2026-08-26T00:00:00Z')
    });

    expect(share.account_identifier).toBe('****7790');
    const insert = mockDb.query.mock.calls[1];
    expect(insert[0]).toContain('INSERT INTO daily_review_shares');
    expect(insert[1][4]).toBe('****7790');
    expect(insert[1][2]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('re-reads the winner when it loses an insert race', async () => {
    // The key is an expression index, which ON CONFLICT cannot target by
    // column list, so the unique violation is caught instead.
    const winner = { id: 's3', token: 'winner' };
    const duplicate = Object.assign(new Error('duplicate key'), { code: '23505' });
    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(duplicate)
      .mockResolvedValueOnce({ rows: [winner] });

    await expect(DailyReviewShare.getOrCreate(USER, DAY)).resolves.toBe(winner);
  });

  it('propagates errors that are not unique violations', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(Object.assign(new Error('connection lost'), { code: '08006' }));

    await expect(DailyReviewShare.getOrCreate(USER, DAY)).rejects.toThrow('connection lost');
  });
});

describe('isExpired', () => {
  it('treats a past expiry as expired', () => {
    expect(DailyReviewShare.isExpired({ expires_at: '2020-01-01T00:00:00Z' })).toBe(true);
  });

  it('treats a future expiry as live', () => {
    expect(DailyReviewShare.isExpired({ expires_at: '2999-01-01T00:00:00Z' })).toBe(false);
  });

  it('treats a missing expiry as never expiring', () => {
    expect(DailyReviewShare.isExpired({ expires_at: null })).toBe(false);
    expect(DailyReviewShare.isExpired({})).toBe(false);
    expect(DailyReviewShare.isExpired(null)).toBe(false);
  });
});

describe('updateAccountSnapshot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.query.mockResolvedValue({ rows: [{ id: 's1' }] });
  });

  it('serializes the strip as jsonb', async () => {
    await DailyReviewShare.updateAccountSnapshot('s1', { netLiq: 1000 });

    expect(lastCall().params[1]).toBe(JSON.stringify({ netLiq: 1000 }));
  });

  it('stores null rather than the string "undefined"', async () => {
    await DailyReviewShare.updateAccountSnapshot('s1', undefined);

    expect(lastCall().params[1]).toBe('null');
  });
});
