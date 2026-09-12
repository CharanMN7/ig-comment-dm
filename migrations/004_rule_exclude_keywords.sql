-- Per-rule exclusion keywords (#22).
--
-- Stored in the same JSON-array shape as `keywords`, so `parseKeywords` reads
-- both and the two lists cannot drift apart in format.
--
-- Defaults to an empty array rather than NULL: every existing rule then has
-- "no exclusions" spelled out, and the read path has one shape to handle
-- instead of two.

ALTER TABLE rules ADD COLUMN exclude_keywords TEXT NOT NULL DEFAULT '[]';
