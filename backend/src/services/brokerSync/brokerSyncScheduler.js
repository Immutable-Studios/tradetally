/**
 * Broker Sync Scheduler
 * Handles automatic scheduled syncing of broker connections
 *
 * Runs every 15 minutes to check for connections due for sync
 */

const BrokerConnection = require('../../models/BrokerConnection');
const brokerSyncService = require('./index');
const db = require('../../config/database');

const SCHEDULER_INTERVAL = 15 * 60 * 1000; // 15 minutes
const MAX_CONCURRENT_SYNCS = 3;

class BrokerSyncScheduler {
  constructor() {
    this.interval = null;
    this.isRunning = false;
    this.currentSyncs = 0;
  }

  /**
   * Process all connections due for scheduled sync
   */
  async processDueSyncs() {
    if (this.isRunning) {
      console.log('[BROKER-SCHEDULER] Previous run still in progress, skipping...');
      return;
    }

    this.isRunning = true;
    const logPrefix = '[BROKER-SCHEDULER]';

    try {
      console.log(`${logPrefix} Checking for scheduled syncs...`);

      // Find connections due for sync
      const dueConnections = await BrokerConnection.findDueForSync();

      if (dueConnections.length === 0) {
        console.log(`${logPrefix} No connections due for sync`);
        return;
      }

      console.log(`${logPrefix} Found ${dueConnections.length} connections due for sync`);

      // Process syncs with concurrency limit
      const results = [];
      const queue = [...dueConnections];

      while (queue.length > 0) {
        // Process up to MAX_CONCURRENT_SYNCS at a time
        const batch = queue.splice(0, MAX_CONCURRENT_SYNCS);

        const batchResults = await Promise.allSettled(
          batch.map(connection => this.syncConnection(connection))
        );

        // Collect results
        batchResults.forEach((result, index) => {
          const connection = batch[index];
          if (result.status === 'fulfilled') {
            results.push({
              connectionId: connection.id,
              brokerType: connection.brokerType,
              userId: connection.userId,
              success: result.value.success,
              imported: result.value.imported || 0,
              duplicates: result.value.duplicates || 0,
              error: result.value.error
            });
          } else {
            results.push({
              connectionId: connection.id,
              brokerType: connection.brokerType,
              userId: connection.userId,
              success: false,
              error: result.reason?.message || 'Unknown error'
            });
          }
        });

        // Small delay between batches to avoid overwhelming APIs
        if (queue.length > 0) {
          await this.sleep(5000);
        }
      }

      // Log summary
      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;
      const totalImported = results.reduce((sum, r) => sum + (r.imported || 0), 0);

      console.log(`${logPrefix} Scheduled sync batch complete:`);
      console.log(`${logPrefix}   Successful: ${successCount}`);
      console.log(`${logPrefix}   Failed: ${failCount}`);
      console.log(`${logPrefix}   Total trades imported: ${totalImported}`);

      // Log failures for debugging
      results.filter(r => !r.success).forEach(r => {
        console.error(`${logPrefix} Failed sync for ${r.brokerType} connection ${r.connectionId}: ${r.error}`);
      });

    } catch (error) {
      console.error(`${logPrefix} [ERROR] Scheduler error:`, error);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Sync a single connection
   */
  async syncConnection(connection) {
    console.log(`[BROKER-SCHEDULER] Syncing ${connection.brokerType} connection ${connection.id}...`);

    try {
      const result = await brokerSyncService.syncConnection(connection.id, {
        syncType: 'scheduled'
      });

      return result;
    } catch (error) {
      console.error(`[BROKER-SCHEDULER] Sync failed for ${connection.id}:`, error.message);

      // Update connection failure status
      await BrokerConnection.updateAfterFailure(connection.id, error.message);

      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Mark any sync logs stuck in 'started' or 'fetching' as failed.
   * These are left over from a previous process that was killed mid-flight.
   */
  async cleanupZombieSyncs() {
    try {
      const result = await db.query(
        `UPDATE broker_sync_logs
         SET status = 'failed',
             error_message = 'Sync interrupted by server restart',
             completed_at = CURRENT_TIMESTAMP
         WHERE status IN ('started', 'fetching')
         RETURNING id`
      );
      if (result.rowCount > 0) {
        console.log(`[BROKER-SCHEDULER] Cleaned up ${result.rowCount} zombie sync log(s) left from previous run`);
      }
    } catch (error) {
      console.error('[BROKER-SCHEDULER] Failed to clean up zombie syncs:', error.message);
    }
  }

  /**
   * Force a sync of every active auto-sync connection the first time a given
   * deployment boots, so shipping code that changes sync/matching behavior takes
   * effect immediately instead of waiting for the next scheduled window.
   *
   * Keyed on the deployment id, NOT on process start: this service runs
   * scale-to-zero, so the process boots on every container wake. The upsert is
   * an atomic claim (single-row table) so concurrent replicas sync only once.
   *
   * Disable with ENABLE_POST_DEPLOY_SYNC=false.
   */
  async syncOnNewDeployment() {
    const logPrefix = '[BROKER-SCHEDULER]';

    if (process.env.ENABLE_POST_DEPLOY_SYNC === 'false') {
      console.log(`${logPrefix} Post-deploy sync disabled (ENABLE_POST_DEPLOY_SYNC=false)`);
      return 0;
    }

    const deploymentId = process.env.RAILWAY_DEPLOYMENT_ID || process.env.RAILWAY_GIT_COMMIT_SHA;
    if (!deploymentId) {
      // Local/self-hosted: no deployment identity to key on, so skip rather than
      // syncing on every restart.
      console.log(`${logPrefix} No deployment id in env, skipping post-deploy sync`);
      return 0;
    }
    const commitSha = process.env.RAILWAY_GIT_COMMIT_SHA || null;

    let claimed;
    try {
      claimed = await db.query(
        `INSERT INTO deploy_sync_state (id, deployment_id, commit_sha, connections_synced, synced_at)
         VALUES (TRUE, $1, $2, 0, CURRENT_TIMESTAMP)
         ON CONFLICT (id) DO UPDATE
           SET deployment_id = EXCLUDED.deployment_id,
               commit_sha = EXCLUDED.commit_sha,
               connections_synced = 0,
               synced_at = CURRENT_TIMESTAMP
         WHERE deploy_sync_state.deployment_id IS DISTINCT FROM EXCLUDED.deployment_id
         RETURNING deployment_id`,
        [deploymentId, commitSha]
      );
    } catch (error) {
      console.error(`${logPrefix} Post-deploy sync claim failed:`, error.message);
      return 0;
    }

    if (claimed.rowCount === 0) {
      console.log(`${logPrefix} Deployment ${deploymentId} already post-deploy synced, skipping`);
      return 0;
    }

    // Every active auto-sync connection, regardless of next_scheduled_sync --
    // that schedule filter is what processDueSyncs() is for.
    const { rows: connections } = await db.query(
      `SELECT id, broker_type, user_id FROM broker_connections
       WHERE auto_sync_enabled = true
         AND connection_status = 'active'
         AND consecutive_failures < 3
       ORDER BY updated_at DESC`
    );

    if (connections.length === 0) {
      console.log(`${logPrefix} Post-deploy sync: no active auto-sync connections`);
      return 0;
    }

    console.log(`${logPrefix} New deployment ${deploymentId} - force-syncing ${connections.length} connection(s)`);

    let synced = 0;
    for (const connection of connections) {
      try {
        const result = await brokerSyncService.syncConnection(connection.id, { syncType: 'scheduled' });
        synced++;
        console.log(
          `${logPrefix} Post-deploy sync ${connection.broker_type} ${connection.id}: ` +
          `imported=${result?.imported || 0} duplicates=${result?.duplicates || 0}`
        );
      } catch (error) {
        console.error(`${logPrefix} Post-deploy sync failed for ${connection.id}:`, error.message);
      }
    }

    await db.query(
      `UPDATE deploy_sync_state SET connections_synced = $1 WHERE id = TRUE`,
      [synced]
    ).catch(() => { /* bookkeeping only */ });

    console.log(`${logPrefix} Post-deploy sync complete: ${synced}/${connections.length} connection(s) synced`);
    return synced;
  }

  /**
   * Start the scheduler
   */
  start() {
    console.log('[BROKER-SCHEDULER] Starting broker sync scheduler...');
    console.log(`[BROKER-SCHEDULER] Check interval: ${SCHEDULER_INTERVAL / 60000} minutes`);

    // Clean up any syncs that were interrupted by a previous server restart
    this.cleanupZombieSyncs().catch(error => {
      console.error('[BROKER-SCHEDULER] Zombie cleanup failed:', error);
    });

    // Fresh deployment? Sync everything now so new matching logic applies
    // immediately. Runs before the due-check below; syncing advances
    // next_scheduled_sync, so processDueSyncs() then finds nothing to redo.
    this.syncOnNewDeployment().catch(error => {
      console.error('[BROKER-SCHEDULER] Post-deploy sync failed:', error);
    });

    // Run immediately on start
    this.processDueSyncs().catch(error => {
      console.error('[BROKER-SCHEDULER] Initial run failed:', error);
    });

    // Schedule regular runs
    this.interval = setInterval(() => {
      this.processDueSyncs().catch(error => {
        console.error('[BROKER-SCHEDULER] Scheduled run failed:', error);
      });
    }, SCHEDULER_INTERVAL);

    console.log('[BROKER-SCHEDULER] Scheduler started');
  }

  /**
   * Stop the scheduler
   */
  stop() {
    console.log('[BROKER-SCHEDULER] Stopping broker sync scheduler...');

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    console.log('[BROKER-SCHEDULER] Scheduler stopped');
  }

  /**
   * Get scheduler status
   */
  getStatus() {
    return {
      running: this.interval !== null,
      processing: this.isRunning,
      checkIntervalMinutes: SCHEDULER_INTERVAL / 60000,
      maxConcurrentSyncs: MAX_CONCURRENT_SYNCS
    };
  }

  /**
   * Sleep helper
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Export singleton instance
module.exports = new BrokerSyncScheduler();
