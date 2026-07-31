jest.mock('../../src/models/ApiKey', () => ({
  verifyKey: jest.fn()
}));

jest.mock('../../src/utils/logger', () => ({
  logError: jest.fn()
}));

jest.mock('../../src/middleware/auth', () => {
  const actual = jest.requireActual('../../src/middleware/auth');
  return {
    ...actual,
    verifyJwtToken: jest.fn(),
    isTokenSessionValid: jest.fn(() => true),
    findActiveUserForAuth: jest.fn()
  };
});

jest.mock('../../src/middleware/mentorAccess', () => {
  const actual = jest.requireActual('../../src/middleware/mentorAccess');
  return {
    ...actual,
    resolveMentorAccess: jest.fn(actual.resolveMentorAccess)
  };
});

const { AUTH_COOKIE_NAME } = require('../../src/utils/authCookies');
const { verifyJwtToken, findActiveUserForAuth } = require('../../src/middleware/auth');
const { resolveMentorAccess } = require('../../src/middleware/mentorAccess');
const { flexibleAuth, flexibleOptionalAuth } = require('../../src/middleware/apiKeyAuth');
const AccountMentor = require('../../src/models/AccountMentor');
const User = require('../../src/models/User');

jest.mock('../../src/models/AccountMentor', () => ({
  activateForUser: jest.fn(async () => []),
  findActiveForMentorUser: jest.fn()
}));

jest.mock('../../src/models/User', () => ({
  findById: jest.fn()
}));

function createRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis()
  };
}

describe('flexibleAuth mentor scoping', () => {
  const mentor = {
    id: 'mentor-1',
    email: 'mentor@example.com',
    username: 'mentor',
    role: 'user',
    is_active: true,
    session_version: 0
  };
  const owner = {
    id: 'owner-1',
    email: 'owner@example.com',
    username: 'owner',
    full_name: 'Owner',
    role: 'admin',
    is_active: true,
    session_version: 0
  };

  beforeEach(() => {
    jest.clearAllMocks();
    verifyJwtToken.mockReturnValue({ id: mentor.id, purpose: 'access', session_version: 0 });
    findActiveUserForAuth.mockResolvedValue(mentor);
    AccountMentor.findActiveForMentorUser.mockResolvedValue({
      id: 'grant-1',
      owner_user_id: owner.id,
      mentor_user_id: mentor.id,
      status: 'active'
    });
    User.findById.mockResolvedValue(owner);
  });

  test('cookie session on /api/trades scopes mentor onto owner journal', async () => {
    const req = {
      headers: {},
      cookies: { [AUTH_COOKIE_NAME]: 'session-token' },
      originalUrl: '/api/trades'
    };
    const res = createRes();
    const next = jest.fn();

    await flexibleAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(resolveMentorAccess).toHaveBeenCalled();
    expect(req.isMentor).toBe(true);
    expect(req.authUser).toEqual(expect.objectContaining({ id: mentor.id }));
    expect(req.user).toEqual(expect.objectContaining({ id: owner.id }));
  });

  test('Bearer JWT path also scopes mentors', async () => {
    const req = {
      headers: { authorization: 'Bearer jwt-token' },
      cookies: {},
      originalUrl: '/api/trades'
    };
    const res = createRes();
    const next = jest.fn();

    await flexibleAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.isMentor).toBe(true);
    expect(req.user.id).toBe(owner.id);
  });

  test('flexibleOptionalAuth cookie path scopes mentors', async () => {
    const req = {
      headers: {},
      cookies: { [AUTH_COOKIE_NAME]: 'session-token' },
      originalUrl: '/api/trades/public'
    };
    const next = jest.fn();

    await flexibleOptionalAuth(req, {}, next);

    expect(next).toHaveBeenCalled();
    expect(req.isMentor).toBe(true);
    expect(req.user.id).toBe(owner.id);
  });
});
