-- A rule that answers every comment on its post, with no keyword: giveaways,
-- waitlists, launches. 0 for every rule saved earlier, so they keep needing a
-- keyword. The admin form refuses 1 without a media_id, and the matcher
-- ignores such a rule anyway: account-wide, it would DM every commenter on
-- every post.

ALTER TABLE rules ADD COLUMN match_all INTEGER NOT NULL DEFAULT 0;
