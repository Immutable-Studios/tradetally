-- Migration 239: establish 2026-07-25 as this instance's data start date.
--
-- Two things happen here, and they are deliberately in one migration so the
-- database can never sit in the state "old rows purged but new ones still
-- accepted" (or vice versa):
--
--   1. Delete every trade dated before 2026-07-25, plus the history and derived
--      analytics computed from those trades.
--   2. Add a CHECK constraint making the cutoff structural, so any writer that
--      bypasses the application guards in src/utils/dataStartDate.js still
--      cannot land pre-cutoff rows.
--
-- THIS IS IRREVERSIBLE AND APPLIES TO EVERY USER ON THE DEPLOYMENT. Rolling it
-- back means restoring from a backup taken before it ran; dropping the
-- constraint alone brings back nothing.
--
-- Not touched, because none of it is trade data: users, settings, accounts,
-- broker connections, tags, playbooks, diary entries and attachments, watchlists,
-- price alerts, investments/Plaid holdings and transactions, and subscriptions.
--
-- The literal is repeated rather than parameterized because the migration runner
-- executes raw SQL with no bind parameters. It must stay equal to
-- DATA_START_DATE in backend/src/utils/dataStartDate.js.

-- 1. Trades. FK cascades take trade_attachments, trade_comments, trade_charts,
--    trade_dividends, trade_hold_patterns, trade_playbook_reviews,
--    trade_split_adjustments, personality_trade_analysis,
--    strategy_classification_history and revenge_trade_tick_analysis with them.
DELETE FROM trades WHERE trade_date < DATE '2026-07-25';

-- Shell trades (open positions with no fills yet) carry a NULL trade_date, so
-- the predicate above misses them. Anything opened before the cutoff is part of
-- the old world too.
DELETE FROM trades WHERE trade_date IS NULL AND created_at < TIMESTAMPTZ '2026-07-25 00:00:00+00';

-- 2. Grouping rows the deleted trades pointed at. Both FKs are ON DELETE SET
--    NULL, so these survive as orphans and have to be swept explicitly.
DELETE FROM round_trip_trades rtt
WHERE NOT EXISTS (SELECT 1 FROM trades t WHERE t.round_trip_id = rtt.id);

DELETE FROM trade_position_groups tpg
WHERE NOT EXISTS (SELECT 1 FROM trades t WHERE t.position_group_id = tpg.id);

-- 3. Derived analytics and behavioural state. These are all recomputed from
--    trades on demand or by their schedulers, so they are cleared wholesale
--    rather than filtered — a partial wipe would leave streaks and profiles
--    describing trades that no longer exist.
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

-- 4. Date-keyed history that would otherwise show equity and P&L for trades
--    that no longer exist.
DELETE FROM equity_history WHERE date < DATE '2026-07-25';
DELETE FROM portfolio_snapshots WHERE snapshot_date < DATE '2026-07-25';
DELETE FROM edge_reports WHERE period_start < DATE '2026-07-25';
DELETE FROM daily_review_shares WHERE share_date < DATE '2026-07-25';

-- Year-in-review is a full recomputation over a year that is now partly gone.
DELETE FROM year_wrapped_data;

-- 5. Ingest history describing imports and syncs of the purged trades.
DELETE FROM import_logs WHERE created_at < TIMESTAMPTZ '2026-07-25 00:00:00+00';
DELETE FROM broker_sync_logs WHERE created_at < TIMESTAMPTZ '2026-07-25 00:00:00+00';

-- 6. Raise every connection's sync floor to the cutoff. Without this, a
--    connection set to "All Time" keeps requesting years of executions that the
--    importer now discards on arrival.
UPDATE broker_connections
SET sync_start_date = DATE '2026-07-25'
WHERE sync_start_date IS NULL OR sync_start_date < DATE '2026-07-25';

-- 7. Make the cutoff structural. NULL is allowed so shell trades (created open,
--    dated when their first fill lands) still work. Runs last so that re-running
--    the migration — which raises duplicate_object here and aborts the rest of
--    the runner's DO block — has nothing left to skip.
ALTER TABLE trades
  ADD CONSTRAINT trades_trade_date_on_or_after_start
  CHECK (trade_date IS NULL OR trade_date >= DATE '2026-07-25');
