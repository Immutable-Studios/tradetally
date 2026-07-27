jest.mock('../../src/models/DailyReviewShare', () => ({
  recordView: jest.fn().mockResolvedValue(undefined),
  updateAccountSnapshot: jest.fn().mockResolvedValue(null)
}));
jest.mock('../../src/services/accountBalanceService', () => ({
  captureAccountSnapshotForDay: jest.fn()
}));
jest.mock('../../src/utils/timezone', () => ({
  getUserTimezone: jest.fn().mockResolvedValue('America/Los_Angeles'),
  getDateInTimezone: jest.fn()
}));

const DailyReviewShare = require('../../src/models/DailyReviewShare');
const AccountBalanceService = require('../../src/services/accountBalanceService');
const { getUserTimezone, getDateInTimezone } = require('../../src/utils/timezone');
const controller = require('../../src/controllers/dailyReviewShare.controller');

const TODAY = '2026-07-27';
const FROZEN = { netLiq: 1000, equityForPct: 950 };

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function mockReq(overrides = {}) {
  return {
    user: { id: 'user-1', username: 'dan' },
    dailyShare: {
      id: 'share-1',
      user_id: 'user-1',
      expires_at: '2026-08-26T00:00:00Z',
      created_at: '2026-07-27T21:00:00Z',
      account_snapshot: FROZEN
    },
    dailyShareDate: TODAY,
    dailyShareAccount: '****5119',
    ...overrides
  };
}

describe('getShareMeta', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getUserTimezone.mockResolvedValue('America/Los_Angeles');
    getDateInTimezone.mockReturnValue(TODAY);
    AccountBalanceService.captureAccountSnapshotForDay.mockResolvedValue(null);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('returns the share metadata', async () => {
    const res = mockRes();

    await controller.getShareMeta(mockReq(), res, jest.fn());

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      date: TODAY,
      account: '****5119',
      username: 'dan',
      accountStrip: FROZEN,
      equityForPct: 950
    }));
  });

  it('labels the unassigned bucket for humans', async () => {
    const res = mockRes();

    await controller.getShareMeta(mockReq({ dailyShareAccount: '__unsorted__' }), res, jest.fn());

    expect(res.json.mock.calls[0][0].account).toBe('Unassigned');
  });

  it('reports no account for a legacy all-accounts share', async () => {
    const res = mockRes();

    await controller.getShareMeta(mockReq({ dailyShareAccount: null }), res, jest.fn());

    expect(res.json.mock.calls[0][0].account).toBeNull();
  });

  it('records the view', async () => {
    await controller.getShareMeta(mockReq(), mockRes(), jest.fn());

    expect(DailyReviewShare.recordView).toHaveBeenCalledWith('share-1');
  });

  it('still responds when recording the view fails', async () => {
    // View counting is fire-and-forget; it must never break the page.
    DailyReviewShare.recordView.mockRejectedValue(new Error('db down'));
    const res = mockRes();

    await controller.getShareMeta(mockReq(), res, jest.fn());
    await new Promise((r) => setImmediate(r));

    expect(res.json).toHaveBeenCalled();
  });

  describe('live strip refresh', () => {
    it('refreshes for today, scoped to the share account and never persisting', async () => {
      // Persisting here would stamp one account's Net Liq onto the user-level
      // equity series just because someone opened a share link.
      const live = { netLiq: 2000, equityForPct: 1900 };
      AccountBalanceService.captureAccountSnapshotForDay.mockResolvedValue(live);
      const res = mockRes();

      await controller.getShareMeta(mockReq(), res, jest.fn());

      expect(AccountBalanceService.captureAccountSnapshotForDay).toHaveBeenCalledWith(
        'user-1', TODAY, { accountIdentifier: '****5119', persistEquity: false }
      );
      expect(DailyReviewShare.updateAccountSnapshot).toHaveBeenCalledWith('share-1', live);
      expect(res.json.mock.calls[0][0].accountStrip).toBe(live);
    });

    it('leaves a past day on its frozen snapshot', async () => {
      // A stale strip on an old share is correct: it is a snapshot of that day.
      const res = mockRes();

      await controller.getShareMeta(mockReq({ dailyShareDate: '2026-07-20' }), res, jest.fn());

      expect(AccountBalanceService.captureAccountSnapshotForDay).not.toHaveBeenCalled();
      expect(res.json.mock.calls[0][0].accountStrip).toBe(FROZEN);
    });

    it("decides today in the user's timezone, not UTC", async () => {
      // A UTC comparison flips hours early or late for anyone outside UTC, so a
      // share could refresh on the wrong calendar day.
      getDateInTimezone.mockReturnValue('2026-07-26');
      const res = mockRes();

      await controller.getShareMeta(mockReq(), res, jest.fn());

      expect(getUserTimezone).toHaveBeenCalledWith('user-1');
      expect(AccountBalanceService.captureAccountSnapshotForDay).not.toHaveBeenCalled();
    });

    it('keeps the frozen strip when the live fetch fails', async () => {
      AccountBalanceService.captureAccountSnapshotForDay.mockRejectedValue(new Error('schwab down'));
      const res = mockRes();

      await controller.getShareMeta(mockReq(), res, jest.fn());

      expect(res.json.mock.calls[0][0].accountStrip).toBe(FROZEN);
    });

    it('keeps the frozen strip when the live fetch returns nothing', async () => {
      AccountBalanceService.captureAccountSnapshotForDay.mockResolvedValue(null);
      const res = mockRes();

      await controller.getShareMeta(mockReq(), res, jest.fn());

      expect(DailyReviewShare.updateAccountSnapshot).not.toHaveBeenCalled();
      expect(res.json.mock.calls[0][0].accountStrip).toBe(FROZEN);
    });
  });

  describe('equityForPct fallbacks', () => {
    it('falls back through sodNetLiq to netLiq', async () => {
      const res = mockRes();
      const share = { ...mockReq().dailyShare, account_snapshot: { netLiq: 500 } };

      await controller.getShareMeta(mockReq({ dailyShare: share, dailyShareDate: '2026-07-20' }), res, jest.fn());

      expect(res.json.mock.calls[0][0].equityForPct).toBe(500);
    });

    it('reports null when there is no strip at all', async () => {
      const res = mockRes();
      const share = { ...mockReq().dailyShare, account_snapshot: null };

      await controller.getShareMeta(mockReq({ dailyShare: share, dailyShareDate: '2026-07-20' }), res, jest.fn());

      expect(res.json.mock.calls[0][0].equityForPct).toBeNull();
      expect(res.json.mock.calls[0][0].accountStrip).toBeNull();
    });
  });

  it('forwards unexpected errors to the error handler', async () => {
    getUserTimezone.mockRejectedValue(new Error('boom'));
    const next = jest.fn();

    await controller.getShareMeta(mockReq(), mockRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
  });
});
