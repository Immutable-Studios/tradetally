-- Attribute trade comments, diary entries, and general notes to the real
-- author (mentor vs owner). user_id remains the account owner / data scope.
-- NULL author_user_id means the owner wrote it (legacy rows + owner writes).

ALTER TABLE trade_comments
  ADD COLUMN IF NOT EXISTS author_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_trade_comments_author_user_id
  ON trade_comments (author_user_id)
  WHERE author_user_id IS NOT NULL;

COMMENT ON COLUMN trade_comments.author_user_id IS
  'Real author when different from account owner (e.g. mentor). NULL = owner-authored.';

ALTER TABLE diary_entries
  ADD COLUMN IF NOT EXISTS author_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- Allow one owner entry and one entry per mentor author per day/type.
ALTER TABLE diary_entries
  DROP CONSTRAINT IF EXISTS diary_entries_user_id_entry_date_entry_type_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_diary_entries_owner_day_type
  ON diary_entries (user_id, entry_date, entry_type)
  WHERE author_user_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_diary_entries_author_day_type
  ON diary_entries (user_id, entry_date, entry_type, author_user_id)
  WHERE author_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_diary_entries_author_user_id
  ON diary_entries (author_user_id)
  WHERE author_user_id IS NOT NULL;

COMMENT ON COLUMN diary_entries.author_user_id IS
  'Real author when different from account owner (e.g. mentor). NULL = owner-authored.';

ALTER TABLE general_notes
  ADD COLUMN IF NOT EXISTS author_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_general_notes_author_user_id
  ON general_notes (author_user_id)
  WHERE author_user_id IS NOT NULL;

COMMENT ON COLUMN general_notes.author_user_id IS
  'Real author when different from account owner (e.g. mentor). NULL = owner-authored.';
