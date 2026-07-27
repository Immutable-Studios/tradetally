-- Migration 240: scope Daily Review shares to a single account.
--
-- A review used to cover the whole user: one share, one email, every account's
-- trades summed together. With two funded accounts that makes the numbers
-- meaningless — day P&L, win rate and "% of equity" all mix books that have
-- nothing to do with each other. Reviews are now generated per account, so the
-- share row needs to record which account it belongs to.
--
-- account_identifier matches trades.account_identifier (Schwab's masked form,
-- e.g. '****5119'), with two reserved values:
--   '__unsorted__' - trades carrying no account identifier. Same sentinel the
--                    trade filters already use (services/tradeQueries.js).
--   NULL           - a legacy all-accounts share, or a quiet day with no
--                    account activity to split by. Existing links keep working.

ALTER TABLE daily_review_shares
  ADD COLUMN IF NOT EXISTS account_identifier TEXT;

COMMENT ON COLUMN daily_review_shares.account_identifier IS
  'Account this review covers (matches trades.account_identifier). ''__unsorted__'' = trades with no account; NULL = all accounts (legacy share or a day with no per-account activity).';

-- The old key allowed exactly one share per user per day, which is precisely
-- what per-account reviews need to break. COALESCE keeps NULL from defeating
-- uniqueness the way a plain multi-column unique index would (NULLs compare as
-- distinct), so a user still cannot end up with two all-accounts shares for the
-- same day. '' is never stored, so it is safe as the NULL stand-in.
ALTER TABLE daily_review_shares
  DROP CONSTRAINT IF EXISTS daily_review_shares_user_id_share_date_key;

CREATE UNIQUE INDEX IF NOT EXISTS daily_review_shares_user_date_account_key
  ON daily_review_shares (user_id, share_date, COALESCE(account_identifier, ''));
