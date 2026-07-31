const {
  resolveMentorAccess,
  rejectMentorImportSettingsBody,
  forbidMentorImportChanges,
  forbidMentorAccountChanges,
  forbidMentorGrantManagement
} = require('../../src/middleware/mentorAccess');

jest.mock('../../src/models/AccountMentor', () => ({
  activateForUser: jest.fn(async () => []),
  findActiveForMentorUser: jest.fn()
}));

jest.mock('../../src/models/User', () => ({
  findById: jest.fn()
}));

const AccountMentor = require('../../src/models/AccountMentor');
const User = require('../../src/models/User');

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe('mentorAccess middleware', () => {
  test('allows non-mentors through import settings checks', () => {
    const req = { body: { enableTradeGrouping: true } };
    const res = mockRes();
    const next = jest.fn();

    rejectMentorImportSettingsBody(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('blocks mentors from changing import settings fields', () => {
    const req = { isMentor: true, body: { enableTradeGrouping: false } };
    const res = mockRes();
    const next = jest.fn();

    rejectMentorImportSettingsBody(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'MENTOR_FORBIDDEN' })
    );
  });

  test('allows mentors to update non-import settings', () => {
    const req = { isMentor: true, body: { theme: 'dark' } };
    const res = mockRes();
    const next = jest.fn();

    rejectMentorImportSettingsBody(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('blocks mentors from import pipeline mutations', () => {
    const req = { isMentor: true, body: {} };
    const res = mockRes();
    const next = jest.fn();

    forbidMentorImportChanges(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('blocks mentors from account security changes', () => {
    const req = { isMentor: true };
    const res = mockRes();
    const next = jest.fn();

    forbidMentorAccountChanges(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('blocks mentors from managing mentor grants', () => {
    const req = { isMentor: true };
    const res = mockRes();
    const next = jest.fn();

    forbidMentorGrantManagement(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('resolveMentorAccess exposes mentor avatar for session chrome', async () => {
    const mentor = {
      id: 'mentor-1',
      email: 'dan@immutablestudios.xyz',
      username: 'dan',
      full_name: 'Dan Mentor',
      avatar_url: 'https://cdn.example/mentor.png'
    };
    const owner = {
      id: 'owner-1',
      email: 'owner@example.com',
      username: 'danieladammiller',
      full_name: 'Daniel',
      is_active: true
    };

    AccountMentor.findActiveForMentorUser.mockResolvedValue({
      id: 'grant-1',
      owner_user_id: owner.id,
      mentor_user_id: mentor.id,
      status: 'active'
    });
    User.findById.mockResolvedValue(owner);

    const req = { user: mentor };
    await resolveMentorAccess(req);

    expect(req.isMentor).toBe(true);
    expect(req.mentorAccess.mentor).toEqual(
      expect.objectContaining({
        id: mentor.id,
        email: mentor.email,
        avatarUrl: mentor.avatar_url,
        fullName: mentor.full_name
      })
    );
    expect(req.user.id).toBe(owner.id);
  });
});
