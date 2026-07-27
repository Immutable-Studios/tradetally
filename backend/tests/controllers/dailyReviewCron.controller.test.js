jest.mock('../../src/services/dailyReviewShareService', () => ({
  runDailyBatch: jest.fn()
}));

const DailyReviewShareService = require('../../src/services/dailyReviewShareService');
const controller = require('../../src/controllers/dailyReviewCron.controller');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

const STATS = { users: 1, sent: 1, skipped: 0, failed: 0 };

describe('dailyReviewCronController.runDailyBatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    DailyReviewShareService.runDailyBatch.mockResolvedValue(STATS);
  });

  it('runs the batch and returns its stats', async () => {
    const res = mockRes();

    await controller.runDailyBatch({ body: {} }, res, jest.fn());

    expect(DailyReviewShareService.runDailyBatch).toHaveBeenCalledWith({ skipIfSentToday: true });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed', users: 1, sent: 1, skipIfSentToday: true
    }));
  });

  it('honors skipIfSentToday=false to force a re-send', async () => {
    const res = mockRes();

    await controller.runDailyBatch({ body: { skipIfSentToday: false } }, res, jest.fn());

    expect(DailyReviewShareService.runDailyBatch).toHaveBeenCalledWith({ skipIfSentToday: false });
  });

  it('returns 202 without waiting when background is set', async () => {
    let release;
    DailyReviewShareService.runDailyBatch.mockReturnValue(new Promise((r) => { release = r; }));
    const res = mockRes();

    await controller.runDailyBatch({ body: { background: true } }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'started' }));
    release(STATS);
    await new Promise((r) => setImmediate(r));
  });

  it('rejects a second run while one is in flight, then frees the lock', async () => {
    let release;
    DailyReviewShareService.runDailyBatch.mockReturnValue(new Promise((r) => { release = r; }));

    const firstRes = mockRes();
    const first = controller.runDailyBatch({ body: {} }, firstRes, jest.fn());

    const secondRes = mockRes();
    await controller.runDailyBatch({ body: {} }, secondRes, jest.fn());
    expect(secondRes.status).toHaveBeenCalledWith(409);
    expect(DailyReviewShareService.runDailyBatch).toHaveBeenCalledTimes(1);

    release(STATS);
    await first;

    // Lock released — a later call gets through.
    DailyReviewShareService.runDailyBatch.mockResolvedValue(STATS);
    const thirdRes = mockRes();
    await controller.runDailyBatch({ body: {} }, thirdRes, jest.fn());
    expect(thirdRes.status).not.toHaveBeenCalledWith(409);
  });

  it('frees the lock and forwards the error when the batch throws', async () => {
    const boom = new Error('batch exploded');
    DailyReviewShareService.runDailyBatch.mockRejectedValue(boom);
    const next = jest.fn();

    await controller.runDailyBatch({ body: {} }, mockRes(), next);
    expect(next).toHaveBeenCalledWith(boom);

    DailyReviewShareService.runDailyBatch.mockResolvedValue(STATS);
    const res = mockRes();
    await controller.runDailyBatch({ body: {} }, res, jest.fn());
    expect(res.status).not.toHaveBeenCalledWith(409);
  });

  it('swallows a background failure instead of rejecting unhandled', async () => {
    DailyReviewShareService.runDailyBatch.mockRejectedValue(new Error('nope'));
    const res = mockRes();

    await controller.runDailyBatch({ body: { background: true } }, res, jest.fn());
    await new Promise((r) => setImmediate(r));

    expect(res.status).toHaveBeenCalledWith(202);
    expect(console.error).toHaveBeenCalled();
  });
});

describe('dailyReviewCronController.getStatus', () => {
  it('reports the configured schedule', async () => {
    const res = mockRes();

    await controller.getStatus({}, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      running: false,
      cron: expect.any(String),
      schedulerEnabled: true
    }));
  });
});
