/**
 * Helpers for attributing comments/notes to the real writer when mentors
 * operate on an owner's account (req.user = owner, req.authUser = mentor).
 */

function getActingAuthorId(req) {
  if (req.isMentor && req.authUser?.id) {
    return req.authUser.id;
  }
  return null;
}

/** Value to store in author_user_id: mentor id, or NULL for owner-authored. */
function resolveAuthorUserId(req) {
  return getActingAuthorId(req);
}

function effectiveAuthorId(row) {
  if (!row) return null;
  return row.author_user_id || row.user_id || null;
}

function isMentorAuthored(row) {
  if (!row || !row.author_user_id) return false;
  return String(row.author_user_id) !== String(row.user_id);
}

/**
 * Mentors may only mutate their own authored rows.
 * Owners may update only owner-authored rows; delete any row on their account.
 */
function canUpdateAuthoredRow(req, row) {
  if (!row) return false;
  if (req.isMentor) {
    return Boolean(req.authUser?.id)
      && String(row.author_user_id) === String(req.authUser.id);
  }
  // Owner: only rewrite owner-authored content
  return !row.author_user_id || String(row.author_user_id) === String(req.user.id);
}

function canDeleteAuthoredRow(req, row) {
  if (!row) return false;
  if (req.isMentor) {
    return Boolean(req.authUser?.id)
      && String(row.author_user_id) === String(req.authUser.id);
  }
  // Owner can remove mentor notes from their journal
  return true;
}

module.exports = {
  getActingAuthorId,
  resolveAuthorUserId,
  effectiveAuthorId,
  isMentorAuthored,
  canUpdateAuthoredRow,
  canDeleteAuthoredRow
};
