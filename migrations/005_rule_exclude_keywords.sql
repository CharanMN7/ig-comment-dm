-- Words that stop a rule from firing even when one of its keywords matched,
-- like "how much" or "not interested". The same JSON-array shape as
-- `keywords`. The default is an empty list, so every rule saved earlier
-- fires exactly as it did.

ALTER TABLE rules ADD COLUMN exclude_keywords TEXT NOT NULL DEFAULT '[]';
