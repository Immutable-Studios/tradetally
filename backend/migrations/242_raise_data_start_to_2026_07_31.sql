-- Migration 242: raise this instance's data start date from 2026-07-25 to
-- 2026-07-31.
--
-- Production was purged operationally first; this migration makes the same
-- cutoff durable for any environment that still has pre-2026-07-31 trades, and
-- keeps DATA_START_DATE in backend/src/utils/dataStartDate.js (and the
-- frontend mirror) aligned with the CHECK constraint.
--
-- Idempotent: re-running deletes nothing extra once the floor is already at
-- 2026-07-31. Must stay equal to DATA_START_DATE in
-- backend/src/utils/dataStartDate.js.

SET LOCAL lock_timeout = '120s';

LOCK TABLE trades IN ACCESS EXCLUSIVE MODE;
LOCK TABLE round_trip_trades IN ACCESS EXCLUSIVE MODE;
LOCK TABLE trade_position_groups IN ACCESS EXCLUSIVE MODE;

DELETE FROM trades WHERE trade_date < DATE '2026-07-31';
DELETE FROM trades WHERE trade_date IS NULL AND created_at < TIMESTAMPTZ '2026-07-31 00:00:00+00';

DELETE FROM round_trip_trades rtt
WHERE NOT EXISTS (SELECT 1 FROM trades t WHERE t.round_trip_id = rtt.id);

DELETE FROM trade_position_groups tpg
WHERE NOT EXISTS (SELECT 1 FROM trades t WHERE t.position_group_id = tpg.id);

DELETE FROM analytics_cache;
DELETE FROM behavioral_alerts;
DELETE FROM behavioral_patterns;
DELETE FROM revenge_trading_events;
DELETE FROM overconfidence_events;
DELETE FROM loss_aversion_events;
DELETE FROM win_loss_streaks;
DELETE FROM trading_personality_profiles;
DELETE FROM personality_drift_tracking;
DELETE FROM personality_peer_comparison;

DELETE FROM equity_history WHERE date < DATE '2026-07-31';
DELETE FROM portfolio_snapshots WHERE snapshot_date < DATE '2026-07-31';
DELETE FROM edge_reports WHERE period_start < DATE '2026-07-31';
DELETE FROM daily_review_shares WHERE share_date < DATE '2026-07-31';
DELETE FROM year_wrapped_data;

DELETE FROM import_logs WHERE created_at < TIMESTAMPTZ '2026-07-31 00:00:00+00';
DELETE FROM broker_sync_logs WHERE created_at < TIMESTAMPTZ '2026-07-31 00:00:00+00';

UPDATE broker_connections
SET sync_start_date = DATE '2026-07-31'
WHERE sync_start_date IS NULL OR sync_start_date < DATE '2026-07-31';

ALTER TABLE trades DROP CONSTRAINT IF EXISTS trades_trade_date_on_or_after_start;
ALTER TABLE trades
  ADD CONSTRAINT trades_trade_date_on_or_after_start
  CHECK (trade_date IS NULL OR trade_date >= DATE '2026-07-31');
