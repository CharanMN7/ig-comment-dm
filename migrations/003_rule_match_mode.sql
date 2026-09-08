-- Per-rule keyword matching mode (#21).
--
-- 'word' is the existing behaviour and stays the default, so every rule that
-- already exists keeps matching exactly as it did. 'contains' is opt-in, for
-- hashtag and brand campaigns where a `launch` rule has to catch `#launch2026`.
--
-- The CHECK constraint is what keeps the column an enum rather than free text:
-- an unrecognised mode would otherwise reach `keywordMatches` and silently pick
-- one branch or the other.

ALTER TABLE rules ADD COLUMN match_mode TEXT NOT NULL DEFAULT 'word'
  CHECK (match_mode IN ('word', 'contains'));
