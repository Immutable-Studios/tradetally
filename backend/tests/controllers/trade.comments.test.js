jest.mock('../../src/models/Trade', () => ({
  findById: jest.fn()
}));
jest.mock('../../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../../src/utils/imageProcessor', () => ({}));
jest.mock('../../src/services/tierService', () => ({}));

const db = require('../../src/config/database');
const Trade = require('../../src/models/Trade');
const tradeController = require('../../src/controllers/trade.controller');

function createRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; }
  };
}

describe('trade comments', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('loads comments with matching SQL parameters', async () => {
    Trade.findById.mockResolvedValue({ id: 'trade-1', is_public: false });
    db.query.mockResolvedValue({ rows: [{ id: 'comment-1' }] });
    const next = jest.fn();
    const res = createRes();

    await tradeController.getComments(
      { params: { id: 'trade-1' }, user: { id: 'user-1' } },
      res,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('$2::boolean'),
      ['trade-1', false]
    );
    expect(res.payload).toEqual({ comments: [{ id: 'comment-1' }] });
  });

  test('adds a public-trade comment with matching SQL parameters', async () => {
    Trade.findById.mockResolvedValue({ id: 'trade-1', is_public: true });
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'comment-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'comment-1', avatar_url: null }] });
    const next = jest.fn();
    const res = createRes();

    await tradeController.addComment(
      {
        params: { id: 'trade-1' },
        user: { id: 'user-1' },
        body: { comment: 'Nice trade' }
      },
      res,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(db.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('author_user_id'),
      ['trade-1', 'user-1', null, 'Nice trade']
    );
    expect(db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('$2::boolean'),
      ['comment-1', true]
    );
    expect(res.statusCode).toBe(201);
  });

  test('attributes mentor comments to authUser while scoping to owner', async () => {
    Trade.findById.mockResolvedValue({ id: 'trade-1', is_public: false });
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'comment-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'comment-1', is_mentor_authored: true }] });
    const next = jest.fn();
    const res = createRes();

    await tradeController.addComment(
      {
        params: { id: 'trade-1' },
        user: { id: 'owner-1' },
        authUser: { id: 'mentor-1' },
        isMentor: true,
        body: { comment: 'Mentor note' }
      },
      res,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(db.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('author_user_id'),
      ['trade-1', 'owner-1', 'mentor-1', 'Mentor note']
    );
    expect(res.statusCode).toBe(201);
  });

  test('updates a public-trade comment with matching SQL parameters', async () => {
    Trade.findById.mockResolvedValue({ id: 'trade-1', is_public: true });
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'comment-1', user_id: 'user-1', author_user_id: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 'comment-1', comment: 'Updated' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'comment-1', avatar_url: null }] });
    const next = jest.fn();
    const res = createRes();

    await tradeController.updateComment(
      {
        params: { id: 'trade-1', commentId: 'comment-1' },
        user: { id: 'user-1' },
        body: { comment: 'Updated' }
      },
      res,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(db.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('$2::boolean'),
      ['comment-1', true]
    );
    expect(res.payload).toEqual({ comment: { id: 'comment-1', avatar_url: null } });
  });

  test('blocks mentors from updating owner-authored comments', async () => {
    Trade.findById.mockResolvedValue({ id: 'trade-1', is_public: false });
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'comment-1', user_id: 'owner-1', author_user_id: null }]
    });
    const next = jest.fn();
    const res = createRes();

    await tradeController.updateComment(
      {
        params: { id: 'trade-1', commentId: 'comment-1' },
        user: { id: 'owner-1' },
        authUser: { id: 'mentor-1' },
        isMentor: true,
        body: { comment: 'Rewrite' }
      },
      res,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.payload.code).toBe('AUTHOR_FORBIDDEN');
  });
});
