-- Mentor mode: an owner can grant another user (identified by email) access to
-- their journal. Mentors authenticate as themselves but operate on the owner's
-- data. Import settings mutations are blocked in application middleware.

CREATE TABLE IF NOT EXISTS account_mentors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mentor_email VARCHAR(255) NOT NULL,
  mentor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'revoked')),
  invite_token VARCHAR(64) UNIQUE,
  invited_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_at TIMESTAMP WITH TIME ZONE,
  revoked_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (owner_user_id, mentor_email)
);

CREATE INDEX IF NOT EXISTS idx_account_mentors_mentor_user_active
  ON account_mentors (mentor_user_id)
  WHERE status = 'active' AND mentor_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_account_mentors_mentor_email_pending
  ON account_mentors (mentor_email)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_account_mentors_invite_token
  ON account_mentors (invite_token)
  WHERE invite_token IS NOT NULL;

COMMENT ON TABLE account_mentors IS 'Grants allowing a mentor (by email) to access an owner''s journal when logged in. Import settings remain owner-only.';
