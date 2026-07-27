// Daily Review email + share link service.
//
// Every day (cron-driven, see dailyReviewEmailScheduler), this mints/reuses
// an opaque share token for the prior trading day and emails a no-login-
// required link to it, along with a quick trade count / P&L summary. The
// link resolves through dailyShareAuth middleware into the same authenticated
// analytics/trade endpoints the logged-in Daily Review page uses.

const db = require('../config/database');
const User = require('../models/User');
const DailyReviewShare = require('../models/DailyReviewShare');
const EmailService = require('./emailService');
const TradeQueries = require('./tradeQueries');
const AccountBalanceService = require('./accountBalanceService');
const { getUserTimezone, getDateInTimezone } = require('../utils/timezone');
const { resolveDailyReviewRecipients } = require('../utils/dailyReviewRecipients');

const DEFAULT_EXPIRES_DAYS = parseInt(process.env.DAILY_REVIEW_SHARE_EXPIRES_DAYS, 10) || 30;

function round2(value) {
  const num = parseFloat(value);
  return Number.isFinite(num) ? Math.round(num * 100) / 100 : null;
}

function formatDateLabel(dateStr) {
  try {
    const [year, month, day] = dateStr.split('-').map(Number);
    const d = new Date(Date.UTC(year, month - 1, day));
    return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  } catch (_) {
    return dateStr;
  }
}

class DailyReviewShareService {
  /**
   * Trading day to review in the user's timezone. The batch runs after the
   * US equity cash close (1:15pm Pacific), so "today" is the settled day.
   */
  static async getDefaultShareDate(userId) {
    const tz = await getUserTimezone(userId);
    return getDateInTimezone(new Date(), tz);
  }

  /**
   * Sync all active broker connections for a user before composing the email
   * so the review reflects the latest fills/positions.
   */
  static async syncBrokersForUser(userId) {
    const BrokerConnection = require('../models/BrokerConnection');
    const BrokerSyncService = require('./brokerSync');

    let connections = [];
    try {
      connections = await BrokerConnection.findByUserId(userId);
    } catch (error) {
      console.error(`[DAILY-REVIEW-SHARE] Failed to load broker connections for ${userId}:`, error.message);
      return { synced: 0, failed: 1 };
    }

    let synced = 0;
    let failed = 0;
    for (const connection of connections) {
      if (connection.connectionStatus !== 'active') continue;
      try {
        console.log(`[DAILY-REVIEW-SHARE] Syncing ${connection.brokerType} (${connection.id}) before daily email`);
        await BrokerSyncService.syncConnection(connection.id, { syncType: 'scheduled' });
        synced++;
      } catch (error) {
        failed++;
        console.error(
          `[DAILY-REVIEW-SHARE] Pre-email sync failed for ${connection.id}:`,
          error.message
        );
      }
    }
    return { synced, failed };
  }

  static buildShareUrl(token) {
    const baseUrl = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
    return `${baseUrl}/daily/share/${token}`;
  }

  static async getDayStats(userId, shareDate) {
    try {
      const analytics = await TradeQueries.getAnalytics(userId, {
        startDate: shareDate,
        endDate: shareDate
      });
      const summary = analytics?.summary || {};
      return {
        tradeCount: parseInt(summary.totalTrades) || 0,
        dayPnL: summary.totalPnL != null ? round2(summary.totalPnL) : null
      };
    } catch (error) {
      console.warn('[DAILY-REVIEW-SHARE] Failed to compute day stats:', error.message);
      return { tradeCount: 0, dayPnL: null };
    }
  }

  /**
   * Creates (or reuses) the share token for a user's day, emails it, and
   * returns the share row. Returns null when the send is skipped (email not
   * configured, user has no address, or the user opted out).
   */
  static async generateAndSendForUser(userId, { shareDate, force = false } = {}) {
    if (!EmailService.isConfigured()) {
      console.log('[DAILY-REVIEW-SHARE] Email not configured, skipping');
      return null;
    }

    const user = await User.findById(userId);
    if (!user || !user.is_active || !user.email) {
      return null;
    }

    if (!force) {
      const settings = await User.getSettings(userId);
      if (settings && settings.daily_review_email_enabled === false) {
        return null;
      }
    }

    // Sync brokers BEFORE composing the email. This call was written but never
    // wired up, so every daily email until now reported pre-sync state -- the
    // day's later fills were missing from the counts, P&L and share page.
    // Failures are logged and swallowed: a stale email beats no email.
    const syncResult = await this.syncBrokersForUser(userId);
    if (syncResult.synced > 0 || syncResult.failed > 0) {
      console.log(
        `[DAILY-REVIEW-SHARE] Pre-email sync for ${userId}: ` +
        `${syncResult.synced} synced, ${syncResult.failed} failed`
      );
    }

    const resolvedDate = shareDate || await this.getDefaultShareDate(userId);
    const expiresAt = new Date(Date.now() + DEFAULT_EXPIRES_DAYS * 24 * 60 * 60 * 1000);

    const share = await DailyReviewShare.getOrCreate(userId, resolvedDate, { expiresAt });

    // Freeze Schwab account strip on the share so the public page can show
    // Net Liq / cash / BP and trade "% of equity" without a live broker call.
    try {
      const strip = await AccountBalanceService.captureAccountSnapshotForDay(userId, resolvedDate);
      if (strip) {
        await DailyReviewShare.updateAccountSnapshot(share.id, strip);
        share.account_snapshot = strip;
      }
    } catch (error) {
      console.warn('[DAILY-REVIEW-SHARE] Account snapshot failed:', error.message);
    }

    const shareUrl = this.buildShareUrl(share.token);
    const { tradeCount, dayPnL } = await this.getDayStats(userId, resolvedDate);

    await EmailService.sendDailyReviewEmail(user, {
      dateLabel: formatDateLabel(resolvedDate),
      shareUrl,
      tradeCount,
      dayPnL,
      recipients: resolveDailyReviewRecipients(user)
    });

    return share;
  }

  /**
   * Daily batch over all active users with an email address, honoring the
   * opt-out flag. Per-user failures are isolated so one bad row can't sink
   * the run.
   *
   * @param {object} options
   * @param {boolean} options.skipIfSentToday - Skip users who already got a
   *   daily review recently. Defaults to true because there are now two
   *   triggers (the in-process cron and the internal HTTP endpoint) and both
   *   can fire on the same day; without this the user gets two emails. Pass
   *   false to force a re-send.
   */
  static async runDailyBatch({ skipIfSentToday = true } = {}) {
    const stats = { users: 0, sent: 0, skipped: 0, failed: 0 };
    let users;
    try {
      // An 18-hour window rather than "today": the batch runs mid-afternoon
      // Pacific, which is already the next UTC day for part of the year, so a
      // calendar-day comparison would miss its own previous run. Consecutive
      // daily runs are 24h apart and so are never wrongly skipped.
      const dedupeClause = skipIfSentToday
        ? `AND NOT EXISTS (
             SELECT 1 FROM email_log el
             WHERE el.user_id = u.id
               AND el.email_type = 'daily_review'
               AND el.status = 'sent'
               AND el.sent_at > NOW() - INTERVAL '18 hours'
           )`
        : '';

      const result = await db.query(`
        SELECT u.id
        FROM users u
        LEFT JOIN user_settings s ON s.user_id = u.id
        WHERE u.is_active = true
          AND u.email IS NOT NULL AND u.email != ''
          AND COALESCE(s.daily_review_email_enabled, true) = true
          ${dedupeClause}
        ORDER BY u.id
      `);
      users = result.rows;
    } catch (error) {
      console.error('[DAILY-REVIEW-SHARE] Failed to load eligible users:', error.message);
      throw error;
    }

    stats.users = users.length;
    console.log(`[DAILY-REVIEW-SHARE] Daily batch starting for ${users.length} user(s)`);

    for (const row of users) {
      try {
        const share = await this.generateAndSendForUser(row.id, { force: true });
        if (share) {
          stats.sent++;
        } else {
          stats.skipped++;
        }
      } catch (error) {
        stats.failed++;
        console.error(`[DAILY-REVIEW-SHARE] Failed to send daily review email for user ${row.id}:`, error.message);
      }
    }

    console.log(`[DAILY-REVIEW-SHARE] Daily batch complete: ${stats.sent} sent, ${stats.skipped} skipped, ${stats.failed} failed`);
    return stats;
  }
}

module.exports = DailyReviewShareService;
