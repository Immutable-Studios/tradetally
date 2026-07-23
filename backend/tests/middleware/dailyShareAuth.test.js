jest.mock('../../src/models/DailyReviewShare', () => ({
  findByToken: jest.fn(),
  isExpired: jest.fn()
}));
jest.mock('../../src/models/User', () => ({
  findById: jest.fn()
}));

const DailyReviewShare = require('../../src/models/DailyReviewShare');
const User = require('../../src/models/User');
const {
  resolveDailyShareToken,
  forceShareDay,
  forceShareDateRange
} = require('../../src/middleware/dailyShareAuth');

function mockRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis()
  };
}

describe('resolveDailyShareToken', () => {
  beforeEach(() => jest.clearAllMocks());

  it('404s when the token does not exist', async () => {
    DailyReviewShare.findByToken.mockResolvedValue(null);
    const req = { params: { token: 'nope' } };
    const res = mockRes();
    const next = jest.fn();

    await resolveDailyShareToken(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('404s when the token is expired', async () => {
    DailyReviewShare.findByToken.mockResolvedValue({ id: 's1', user_id: 'u1', expires_at: '2020-01-01' });
    DailyReviewShare.isExpired.mockReturnValue(true);
    const req = { params: { token: 'expired' } };
    const res = mockRes();
    const next = jest.fn();

    await resolveDailyShareToken(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('404s when the owning user no longer exists or is inactive', async () => {
    DailyReviewShare.findByToken.mockResolvedValue({ id: 's1', user_id: 'u1' });
    DailyReviewShare.isExpired.mockReturnValue(false);
    User.findById.mockResolvedValue(null);
    const req = { params: { token: 'tok' } };
    const res = mockRes();
    const next = jest.fn();

    await resolveDailyShareToken(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('sets req.user and req.dailyShareDate and calls next on success', async () => {
    const share = { id: 's1', user_id: 'u1', share_date: new Date('2026-07-18T00:00:00.000Z') };
    DailyReviewShare.findByToken.mockResolvedValue(share);
    DailyReviewShare.isExpired.mockReturnValue(false);
    User.findById.mockResolvedValue({ id: 'u1', is_active: true, email: 'a@b.com' });
    const req = { params: { token: 'tok' } };
    const res = mockRes();
    const next = jest.fn();

    await resolveDailyShareToken(req, res, next);

    expect(req.user).toEqual({ id: 'u1', is_active: true, email: 'a@b.com' });
    expect(req.dailyShare).toBe(share);
    expect(req.dailyShareDate).toBe('2026-07-18');
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('forceShareDay / forceShareDateRange', () => {
  it('overwrites req.query.date with the share date, ignoring caller input', () => {
    const req = { dailyShareDate: '2026-07-18', query: { date: '1999-01-01' } };
    const next = jest.fn();

    forceShareDay(req, {}, next);

    expect(req.query.date).toBe('2026-07-18');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('overwrites req.query.startDate/endDate with the share date, ignoring caller input', () => {
    const req = { dailyShareDate: '2026-07-18', query: { startDate: '1999-01-01', endDate: '2099-01-01' } };
    const next = jest.fn();

    forceShareDateRange(req, {}, next);

    expect(req.query.startDate).toBe('2026-07-18');
    expect(req.query.endDate).toBe('2026-07-18');
    expect(req.query.limit).toBe('200');
    expect(next).toHaveBeenCalledTimes(1);
  });
});
