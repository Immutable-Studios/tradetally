// Daily review email routing.
//
// By default the daily review goes to the account's own login address. Set
// DAILY_REVIEW_RECIPIENTS to deliver one account's review somewhere else
// instead -- a personal inbox, a partner, or both -- without touching the
// login email the account signs in with.
//
// The override is deliberately scoped to a single account via
// DAILY_REVIEW_OWNER_EMAIL. A recipient list with no owner is ignored rather
// than applied globally: on a multi-user instance a global redirect would mail
// every user's trades and P&L to someone else's inbox.
//
//   DAILY_REVIEW_OWNER_EMAIL=owner@example.com
//   DAILY_REVIEW_RECIPIENTS=personal@example.com,partner@example.com

const { normalizeEmail } = require('./normalizeEmail');
const maskEmail = require('./maskEmail');

// Deliberately loose: this is operator-supplied config, not user input. We
// only need to reject obvious junk (empty entries, missing @) so a typo in a
// Railway variable can't turn into a provider-level send failure.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let warnedAboutMissingOwner = false;

/**
 * Parse a comma/semicolon/whitespace separated address list into normalized,
 * deduped addresses. Malformed entries are dropped.
 */
function parseRecipientList(raw) {
  if (!raw || typeof raw !== 'string') return [];

  const seen = new Set();
  const recipients = [];
  for (const part of raw.split(/[,;\s]+/)) {
    const email = normalizeEmail(part);
    if (!email || !EMAIL_SHAPE.test(email) || seen.has(email)) continue;
    seen.add(email);
    recipients.push(email);
  }
  return recipients;
}

/**
 * Addresses that should receive this user's daily review.
 *
 * Returns the configured override list when the user is the designated owner,
 * otherwise the user's own address. Env is read per call so a Railway variable
 * change takes effect on the next restart without a code change.
 *
 * @param {object} user - User row (needs `email`)
 * @returns {string[]} recipient addresses, possibly empty
 */
function resolveDailyReviewRecipients(user) {
  const ownAddress = user && user.email ? String(user.email).trim() : '';
  const fallback = ownAddress ? [ownAddress] : [];

  const overrides = parseRecipientList(process.env.DAILY_REVIEW_RECIPIENTS);
  if (!overrides.length) return fallback;

  const owner = normalizeEmail(process.env.DAILY_REVIEW_OWNER_EMAIL || '');
  if (!owner) {
    if (!warnedAboutMissingOwner) {
      warnedAboutMissingOwner = true;
      console.warn(
        '[DAILY-REVIEW-SHARE] DAILY_REVIEW_RECIPIENTS is set but ' +
        'DAILY_REVIEW_OWNER_EMAIL is not — ignoring the override so no user\'s ' +
        'review is mailed to another account\'s recipients.'
      );
    }
    return fallback;
  }

  if (!ownAddress || normalizeEmail(ownAddress) !== owner) return fallback;

  // Logged every run: without it, a typo in DAILY_REVIEW_OWNER_EMAIL looks
  // identical to a working config until someone notices the mail went nowhere.
  console.log(
    `[DAILY-REVIEW-SHARE] Routing ${maskEmail(ownAddress)} review to ` +
    `${overrides.map(maskEmail).join(', ')} (DAILY_REVIEW_RECIPIENTS)`
  );

  return overrides;
}

module.exports = { resolveDailyReviewRecipients, parseRecipientList };
