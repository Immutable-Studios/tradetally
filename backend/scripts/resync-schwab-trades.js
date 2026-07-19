#!/usr/bin/env node
/**
 * Delete Schwab-synced trades and re-import with current matcher.
 * Usage (from Railway app env or local with prod env):
 *   node scripts/resync-schwab-trades.js
 *   node scripts/resync-schwab-trades.js --dry-run
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const db = require('../src/config/database');
const BrokerConnection = require('../src/models/BrokerConnection');
const brokerSyncService = require('../src/services/brokerSync');
const AnalyticsCache = require('../src/services/analyticsCache');
const OptionStrategyGroupingService = require('../src/services/optionStrategyGroupingService');

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const connResult = await db.query(
    `SELECT id, user_id, broker_type, connection_status
     FROM broker_connections
     WHERE broker_type = 'schwab' AND connection_status = 'active'
     ORDER BY updated_at DESC`
  );

  if (connResult.rows.length === 0) {
    throw new Error('No active Schwab broker connection found');
  }

  for (const row of connResult.rows) {
    const connectionId = row.id;
    const userId = row.user_id;

    const countResult = await db.query(
      `SELECT COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE exit_price IS NULL AND exit_time IS NULL)::int AS open_n
       FROM trades
       WHERE user_id = $1 AND broker_connection_id = $2`,
      [userId, connectionId]
    );
    const { n, open_n: openN } = countResult.rows[0];
    console.log(`[RESYNC] connection=${connectionId} user=${userId} trades=${n} open=${openN} dryRun=${dryRun}`);

    if (dryRun) continue;

    const deleted = await db.query(
      `DELETE FROM trades WHERE user_id = $1 AND broker_connection_id = $2 RETURNING id`,
      [userId, connectionId]
    );
    console.log(`[RESYNC] Deleted ${deleted.rowCount} trades`);

    await OptionStrategyGroupingService.rebuildUserGroupsSafe(userId, 'schwab resync wipe');
    await AnalyticsCache.invalidate(userId);

    // Ensure Pro access for broker sync (self-hosted / single-user)
    await db.query(
      `UPDATE users SET tier = 'pro' WHERE id = $1 AND (tier IS NULL OR tier = 'free')`,
      [userId]
    );

    console.log('[RESYNC] Starting Schwab sync...');
    const result = await brokerSyncService.syncConnection(connectionId, { syncType: 'manual' });
    console.log('[RESYNC] Sync result:', JSON.stringify(result, null, 2));

    const after = await db.query(
      `SELECT COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE exit_price IS NULL AND exit_time IS NULL)::int AS open_n
       FROM trades
       WHERE user_id = $1 AND broker_connection_id = $2`,
      [userId, connectionId]
    );
    console.log(`[RESYNC] After: trades=${after.rows[0].n} open=${after.rows[0].open_n}`);
  }
}

main()
  .then(async () => {
    await db.pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('[RESYNC] Failed:', err);
    try { await db.pool.end(); } catch (_) { /* ignore */ }
    process.exit(1);
  });
