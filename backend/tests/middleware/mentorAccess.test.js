const {
  rejectMentorImportSettingsBody,
  forbidMentorImportChanges,
  forbidMentorAccountChanges,
  forbidMentorGrantManagement
} = require('../../src/middleware/mentorAccess');

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
});
