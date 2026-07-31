const AccountMentor = require('../models/AccountMentor');
const User = require('../models/User');

const IMPORT_SETTINGS_KEYS = new Set([
  'enableTradeGrouping',
  'enable_trade_grouping',
  'tradeGroupingTimeGapMinutes',
  'trade_grouping_time_gap_minutes',
  'importSettings',
  'import_settings',
  'defaultBroker',
  'default_broker'
]);

/**
 * After a normal authenticate, if the logged-in user is a mentor for an owner,
 * switch req.user to the owner so every downstream query is owner-scoped.
 * The real session identity stays on req.authUser.
 */
async function resolveMentorAccess(req) {
  if (!req.user || req.isMentor) return;

  // Activate any pending invites that match this login email.
  try {
    await AccountMentor.activateForUser(req.user);
  } catch (err) {
    console.warn('[MENTOR] Failed to activate pending invites:', err.message);
  }

  const grant = await AccountMentor.findActiveForMentorUser(req.user.id);
  if (!grant) return;

  const owner = await User.findById(grant.owner_user_id);
  if (!owner || !owner.is_active) return;

  req.authUser = req.user;
  req.user = owner;
  req.isMentor = true;
  req.mentorGrant = grant;
  req.mentorAccess = {
    isMentor: true,
    canChangeImportSettings: false,
    owner: {
      id: owner.id,
      email: owner.email,
      username: owner.username,
      fullName: owner.full_name
    },
    mentor: {
      id: req.authUser.id,
      email: req.authUser.email,
      username: req.authUser.username,
      fullName: req.authUser.full_name
    }
  };
}

function isMentorRequest(req) {
  return Boolean(req.isMentor);
}

function mentorForbidden(res, message = 'Mentors cannot perform this action') {
  return res.status(403).json({
    error: message,
    code: 'MENTOR_FORBIDDEN'
  });
}

/** Block mentors from account-security / admin / billing style mutations. */
function forbidMentorAccountChanges(req, res, next) {
  if (isMentorRequest(req)) {
    return mentorForbidden(res, 'Mentors cannot change account security or billing settings');
  }
  return next();
}

/** Block mentors from managing mentor grants on the owner's account. */
function forbidMentorGrantManagement(req, res, next) {
  if (isMentorRequest(req)) {
    return mentorForbidden(res, 'Mentors cannot manage mentor access');
  }
  return next();
}

/**
 * Block import-settings writes and import pipeline mutations for mentors.
 * For settings PUT, reject if any import-related field is present.
 */
function forbidMentorImportChanges(req, res, next) {
  if (!isMentorRequest(req)) return next();

  if (req.body && typeof req.body === 'object') {
    const forbidden = Object.keys(req.body).filter((key) => IMPORT_SETTINGS_KEYS.has(key));
    if (forbidden.length > 0) {
      return mentorForbidden(res, 'Mentors cannot change import settings');
    }
  }

  return mentorForbidden(res, 'Mentors cannot change import settings');
}

/** Soft check used on general settings PUT — strip/reject only import keys. */
function rejectMentorImportSettingsBody(req, res, next) {
  if (!isMentorRequest(req)) return next();

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const forbidden = Object.keys(body).filter((key) => IMPORT_SETTINGS_KEYS.has(key));
  if (forbidden.length > 0) {
    return mentorForbidden(res, 'Mentors cannot change import settings');
  }
  return next();
}

module.exports = {
  IMPORT_SETTINGS_KEYS,
  resolveMentorAccess,
  isMentorRequest,
  mentorForbidden,
  forbidMentorAccountChanges,
  forbidMentorGrantManagement,
  forbidMentorImportChanges,
  rejectMentorImportSettingsBody
};
