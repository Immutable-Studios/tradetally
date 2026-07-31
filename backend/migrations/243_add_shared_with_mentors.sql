-- Let owners mark which brokerage accounts mentors can see.
-- Default TRUE so existing accounts stay visible to mentors.

ALTER TABLE user_accounts
  ADD COLUMN IF NOT EXISTS shared_with_mentors BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN user_accounts.shared_with_mentors IS
  'When false, mentor-mode trade queries hide this account unless explicitly filtered by the owner. Mentors only see shared accounts.';
