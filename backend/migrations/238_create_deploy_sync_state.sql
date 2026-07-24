-- Migration 238: remember which deployment last triggered the automatic
-- post-deploy broker sync.
--
-- The app runs scale-to-zero on Railway, so the Node process boots every time a
-- sleeping container wakes -- far more often than we actually ship code. Keying
-- the post-deploy sync on the deployment id (rather than "on startup") means a
-- new release syncs exactly once, and container wakes don't re-trigger it.
--
-- Single-row table: the CHECK (id) plus BOOLEAN PRIMARY KEY keeps it a
-- singleton, so the upsert in brokerSyncScheduler.syncOnNewDeployment() is an
-- atomic claim even if several replicas boot at the same time.

CREATE TABLE IF NOT EXISTS deploy_sync_state (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE,
  deployment_id TEXT,
  commit_sha TEXT,
  connections_synced INTEGER DEFAULT 0,
  synced_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT deploy_sync_state_singleton CHECK (id)
);
