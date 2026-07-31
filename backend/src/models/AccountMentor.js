const crypto = require('crypto');
const db = require('../config/database');
const { normalizeEmail } = require('../utils/normalizeEmail');

class AccountMentor {
  static generateInviteToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  static async listForOwner(ownerUserId) {
    const result = await db.query(
      `SELECT
         am.id,
         am.owner_user_id,
         am.mentor_email,
         am.mentor_user_id,
         am.status,
         am.invited_at,
         am.accepted_at,
         am.revoked_at,
         am.created_at,
         u.username AS mentor_username,
         u.full_name AS mentor_full_name
       FROM account_mentors am
       LEFT JOIN users u ON u.id = am.mentor_user_id
       WHERE am.owner_user_id = $1
         AND am.status IN ('pending', 'active')
       ORDER BY am.created_at DESC`,
      [ownerUserId]
    );
    return result.rows;
  }

  static async findActiveForMentorUser(mentorUserId) {
    const result = await db.query(
      `SELECT
         am.*,
         owner.email AS owner_email,
         owner.username AS owner_username,
         owner.full_name AS owner_full_name,
         owner.is_active AS owner_is_active
       FROM account_mentors am
       JOIN users owner ON owner.id = am.owner_user_id
       WHERE am.mentor_user_id = $1
         AND am.status = 'active'
         AND owner.is_active = true
       ORDER BY am.accepted_at DESC NULLS LAST, am.created_at DESC
       LIMIT 1`,
      [mentorUserId]
    );
    return result.rows[0] || null;
  }

  static async findPendingByEmail(email) {
    const normalized = normalizeEmail(email);
    const result = await db.query(
      `SELECT am.*,
              owner.email AS owner_email,
              owner.username AS owner_username,
              owner.full_name AS owner_full_name
       FROM account_mentors am
       JOIN users owner ON owner.id = am.owner_user_id
       WHERE am.mentor_email = $1
         AND am.status = 'pending'
         AND owner.is_active = true
       ORDER BY am.invited_at DESC`,
      [normalized]
    );
    return result.rows;
  }

  static async findByInviteToken(token) {
    if (!token) return null;
    const result = await db.query(
      `SELECT am.*,
              owner.email AS owner_email,
              owner.username AS owner_username,
              owner.full_name AS owner_full_name
       FROM account_mentors am
       JOIN users owner ON owner.id = am.owner_user_id
       WHERE am.invite_token = $1
         AND am.status = 'pending'
         AND owner.is_active = true
       LIMIT 1`,
      [token]
    );
    return result.rows[0] || null;
  }

  static async findExisting(ownerUserId, email) {
    const result = await db.query(
      `SELECT * FROM account_mentors
       WHERE owner_user_id = $1 AND mentor_email = $2
       LIMIT 1`,
      [ownerUserId, normalizeEmail(email)]
    );
    return result.rows[0] || null;
  }

  static async invite({ ownerUserId, mentorEmail, mentorUserId = null }) {
    const email = normalizeEmail(mentorEmail);
    const token = this.generateInviteToken();
    const status = mentorUserId ? 'active' : 'pending';
    const acceptedAt = mentorUserId ? new Date() : null;

    const existing = await this.findExisting(ownerUserId, email);
    if (existing) {
      if (existing.status === 'active') {
        const err = new Error('This mentor already has access');
        err.code = 'MENTOR_EXISTS';
        throw err;
      }

      const result = await db.query(
        `UPDATE account_mentors
         SET mentor_user_id = $1,
             status = $2,
             invite_token = $3,
             invited_at = CURRENT_TIMESTAMP,
             accepted_at = $4,
             revoked_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $5
         RETURNING *`,
        [mentorUserId, status, mentorUserId ? null : token, acceptedAt, existing.id]
      );
      return result.rows[0];
    }

    const result = await db.query(
      `INSERT INTO account_mentors (
         owner_user_id, mentor_email, mentor_user_id, status, invite_token, accepted_at
       ) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [ownerUserId, email, mentorUserId, status, mentorUserId ? null : token, acceptedAt]
    );
    return result.rows[0];
  }

  static async activateForUser(mentorUser) {
    const email = normalizeEmail(mentorUser.email);
    const result = await db.query(
      `UPDATE account_mentors
       SET mentor_user_id = $1,
           status = 'active',
           invite_token = NULL,
           accepted_at = COALESCE(accepted_at, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
       WHERE mentor_email = $2
         AND status = 'pending'
       RETURNING *`,
      [mentorUser.id, email]
    );
    return result.rows;
  }

  static async activateByToken(token, mentorUser) {
    const invite = await this.findByInviteToken(token);
    if (!invite) return null;

    if (normalizeEmail(mentorUser.email) !== normalizeEmail(invite.mentor_email)) {
      const err = new Error('Invite email does not match this account');
      err.code = 'MENTOR_EMAIL_MISMATCH';
      throw err;
    }

    const result = await db.query(
      `UPDATE account_mentors
       SET mentor_user_id = $1,
           status = 'active',
           invite_token = NULL,
           accepted_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND status = 'pending'
       RETURNING *`,
      [mentorUser.id, invite.id]
    );
    return result.rows[0] || null;
  }

  static async revoke(ownerUserId, mentorId) {
    const result = await db.query(
      `UPDATE account_mentors
       SET status = 'revoked',
           invite_token = NULL,
           revoked_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
         AND owner_user_id = $2
         AND status IN ('pending', 'active')
       RETURNING *`,
      [mentorId, ownerUserId]
    );
    return result.rows[0] || null;
  }
}

module.exports = AccountMentor;
