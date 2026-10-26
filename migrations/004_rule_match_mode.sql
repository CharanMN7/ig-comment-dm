-- How a rule's keywords are found in a comment. 'word' is the only behaviour
-- that existed before this column, so it is the default: every rule saved
-- earlier keeps matching exactly as it did. 'contains' is a plain substring
-- match, for hashtag campaigns like #launch2026.

ALTER TABLE rules ADD COLUMN match_mode TEXT NOT NULL DEFAULT 'word'
  CHECK (match_mode IN ('word', 'contains'));
