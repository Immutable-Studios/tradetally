-- Daily review share links: opaque tokens that grant read-only, unauthenticated
-- access to a single day's Daily Review (trades for the day + open positions
-- context) for the owning user. Used by the daily review email so the emailed
-- link works without logging in. One row per (user, day) — the scheduler
-- reuses the existing row for a day instead of minting a new token on retry.

CREATE TABLE IF NOT EXISTS daily_review_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  share_date DATE NOT NULL,
  token VARCHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMP WITH TIME ZONE,
  view_count INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, share_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_review_shares_token
  ON daily_review_shares (token);

CREATE INDEX IF NOT EXISTS idx_daily_review_shares_user_date
  ON daily_review_shares (user_id, share_date DESC);

-- Opt-out flag: defaults to enabled since this is a proactive, single-user
-- feature (the daily email is the whole point), unlike the opt-in weekly
-- edge report.
ALTER TABLE user_settings
ADD COLUMN IF NOT EXISTS daily_review_email_enabled BOOLEAN DEFAULT TRUE;

COMMENT ON TABLE daily_review_shares IS 'Opaque share tokens granting unauthenticated, read-only access to one user''s Daily Review for one day. Created by the daily review email job.';
COMMENT ON COLUMN user_settings.daily_review_email_enabled IS 'When true, the user receives a daily email with a shareable link to that day''s Daily Review (opt-out).';
