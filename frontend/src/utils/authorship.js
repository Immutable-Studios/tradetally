/**
 * Frontend helpers for mentor vs owner authorship on comments / journal notes.
 * Mentors see authStore.user as the owner; real session id is mentorAccess.mentor.id.
 */

export function sessionAuthorId(authStore) {
  if (authStore?.isMentor) {
    return authStore.mentorAccess?.mentor?.id || null
  }
  return authStore?.user?.id || null
}

export function effectiveAuthorId(item) {
  if (!item) return null
  return item.author_user_id || item.user_id || null
}

export function isMentorAuthored(item) {
  if (!item) return false
  if (typeof item.is_mentor_authored === 'boolean') return item.is_mentor_authored
  return Boolean(item.author_user_id && item.author_user_id !== item.user_id)
}

export function authorDisplayName(item) {
  if (!item) return 'Unknown'
  if (item.author_full_name) return item.author_full_name
  if (item.username) return item.username
  if (item.author_email) return item.author_email
  return 'Unknown'
}

export function canEditAuthoredItem(authStore, item) {
  const sessionId = sessionAuthorId(authStore)
  if (!sessionId || !item) return false
  return String(effectiveAuthorId(item)) === String(sessionId)
}

/** Owners may delete mentor notes; mentors may only delete their own. */
export function canDeleteAuthoredItem(authStore, item) {
  if (canEditAuthoredItem(authStore, item)) return true
  if (!authStore?.isMentor && isMentorAuthored(item)) return true
  return false
}
