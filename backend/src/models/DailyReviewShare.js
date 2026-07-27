const db = require('../config/database');
const crypto = require('crypto');

class DailyReviewShare {
  static generateToken() {
    // Opaque, unguessable token - same convention as password reset /
    // email verification tokens elsewhere in this codebase.
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * A share is identified by (user, day, account). accountIdentifier null means
   * the all-accounts share — either a legacy row or a day with no per-account
   * activity to split by. COALESCE mirrors the unique index from migration 240:
   * `= NULL` would never match, so a null lookup has to be an IS NULL test.
   */
  static async findByUserAndDate(userId, shareDate, accountIdentifier = null) {
    const result = await db.query(
      `SELECT * FROM daily_review_shares
        WHERE user_id = $1 AND share_date = $2
          AND COALESCE(account_identifier, '') = COALESCE($3::text, '')`,
      [userId, shareDate, accountIdentifier]
    );
    return result.rows[0] || null;
  }

  /** Every share minted for a user's day, one per account. */
  static async findAllByUserAndDate(userId, shareDate) {
    const result = await db.query(
      `SELECT * FROM daily_review_shares
        WHERE user_id = $1 AND share_date = $2
        ORDER BY account_identifier NULLS FIRST`,
      [userId, shareDate]
    );
    return result.rows;
  }

  static async findByToken(token) {
    if (!token || typeof token !== 'string') return null;
    const result = await db.query(
      `SELECT * FROM daily_review_shares WHERE token = $1`,
      [token]
    );
    return result.rows[0] || null;
  }

  /**
   * Get (or create) the share token for one account's day. Idempotent per
   * (user_id, share_date, account_identifier) so a scheduler retry or re-send
   * reuses the same link instead of invalidating the one already emailed.
   */
  static async getOrCreate(userId, shareDate, { expiresAt = null, accountIdentifier = null } = {}) {
    const existing = await this.findByUserAndDate(userId, shareDate, accountIdentifier);
    if (existing) return existing;

    const token = this.generateToken();
    try {
      const result = await db.query(
        `INSERT INTO daily_review_shares (user_id, share_date, token, expires_at, account_identifier)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [userId, shareDate, token, expiresAt, accountIdentifier]
      );
      return result.rows[0];
    } catch (error) {
      // 23505 = unique_violation. Catching it rather than using ON CONFLICT:
      // the key is an expression index (COALESCE), which conflict inference
      // cannot target by column list. Lost the race — read back the winner.
      if (error.code !== '23505') throw error;
      return this.findByUserAndDate(userId, shareDate, accountIdentifier);
    }
  }

  static async recordView(id) {
    await db.query(
      `UPDATE daily_review_shares
       SET view_count = view_count + 1, last_viewed_at = NOW()
       WHERE id = $1`,
      [id]
    );
  }

  static async updateAccountSnapshot(id, snapshot) {
    const result = await db.query(
      `UPDATE daily_review_shares
       SET account_snapshot = $2::jsonb
       WHERE id = $1
       RETURNING *`,
      [id, JSON.stringify(snapshot || null)]
    );
    return result.rows[0] || null;
  }

  static isExpired(share) {
    return Boolean(share?.expires_at) && new Date(share.expires_at).getTime() <= Date.now();
  }
}

module.exports = DailyReviewShare;
