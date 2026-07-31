const {
  resolveAuthorUserId,
  effectiveAuthorId,
  isMentorAuthored,
  canUpdateAuthoredRow,
  canDeleteAuthoredRow
} = require('../../src/utils/authorship');

describe('authorship helpers', () => {
  test('resolveAuthorUserId stores mentor id only for mentor requests', () => {
    expect(resolveAuthorUserId({ isMentor: false, user: { id: 'owner' } })).toBeNull();
    expect(resolveAuthorUserId({
      isMentor: true,
      user: { id: 'owner' },
      authUser: { id: 'mentor' }
    })).toBe('mentor');
  });

  test('effectiveAuthorId falls back to account owner', () => {
    expect(effectiveAuthorId({ user_id: 'owner', author_user_id: null })).toBe('owner');
    expect(effectiveAuthorId({ user_id: 'owner', author_user_id: 'mentor' })).toBe('mentor');
  });

  test('isMentorAuthored detects mentor rows', () => {
    expect(isMentorAuthored({ user_id: 'owner', author_user_id: null })).toBe(false);
    expect(isMentorAuthored({ user_id: 'owner', author_user_id: 'mentor' })).toBe(true);
  });

  test('mentors can only update/delete their own authored rows', () => {
    const mentorReq = {
      isMentor: true,
      user: { id: 'owner' },
      authUser: { id: 'mentor' }
    };
    const mentorRow = { user_id: 'owner', author_user_id: 'mentor' };
    const ownerRow = { user_id: 'owner', author_user_id: null };

    expect(canUpdateAuthoredRow(mentorReq, mentorRow)).toBe(true);
    expect(canDeleteAuthoredRow(mentorReq, mentorRow)).toBe(true);
    expect(canUpdateAuthoredRow(mentorReq, ownerRow)).toBe(false);
    expect(canDeleteAuthoredRow(mentorReq, ownerRow)).toBe(false);
  });

  test('owners can update own rows and delete mentor rows but not edit mentor rows', () => {
    const ownerReq = { isMentor: false, user: { id: 'owner' } };
    const mentorRow = { user_id: 'owner', author_user_id: 'mentor' };
    const ownerRow = { user_id: 'owner', author_user_id: null };

    expect(canUpdateAuthoredRow(ownerReq, ownerRow)).toBe(true);
    expect(canUpdateAuthoredRow(ownerReq, mentorRow)).toBe(false);
    expect(canDeleteAuthoredRow(ownerReq, mentorRow)).toBe(true);
  });
});
