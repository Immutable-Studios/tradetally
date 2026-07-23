-- Freeze Schwab-style account balances on the daily review share so the
-- public magic link can show Net Liq / cash / buying power without calling
-- Schwab at view time, and so trade "% of equity" has a stable denominator.

ALTER TABLE daily_review_shares
ADD COLUMN IF NOT EXISTS account_snapshot JSONB;

COMMENT ON COLUMN daily_review_shares.account_snapshot IS
  'Frozen account strip for the share day: netLiq, sodNetLiq, cash, buyingPower, dayPlApprox, etc.';
