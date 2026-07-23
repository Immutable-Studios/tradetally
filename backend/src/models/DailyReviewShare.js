const db = require('../config/database');
const crypto = require('crypto');

class DailyReviewShare {
  static generateToken() {
    // Opaque, unguessable token - same convention as password reset /
    // email verification tokens elsewhere in this codebase.
    return crypto.randomBytes(32).toString('hex');
  }

  static async findByUserAndDate(userId, shareDate) {
    const result = await db.query(
      `SELECT * FROM daily_review_shares WHERE user_id = $1 AND share_date = $2`,
      [userId, shareDate]
    );
    return result.rows[0] || null;
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
   * Get (or create) the share token for a user's day. Idempotent per
   * (user_id, share_date) so a scheduler retry or re-send reuses the same
   * link instead of invalidating the one already emailed.
   */
  static async getOrCreate(userId, shareDate, { expiresAt = null } = {}) {
    const existing = await this.findByUserAndDate(userId, shareDate);
    if (existing) return existing;

    const token = this.generateToken();
    const result = await db.query(
      `INSERT INTO daily_review_shares (user_id, share_date, token, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, share_date) DO NOTHING
       RETURNING *`,
      [userId, shareDate, token, expiresAt]
    );

    if (result.rows[0]) return result.rows[0];

    // Lost a create race against a concurrent request - read back the winner.
    return this.findByUserAndDate(userId, shareDate);
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
