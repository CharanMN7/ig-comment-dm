-- Lets Home's today, 7-day and 30-day totals, its last-20 list and the stale
-- send sweep read only the rows in their time range. Before this, the only
-- index on `sent` led with ig_user_id, so each of those read the whole table,
-- which is never pruned.
--
-- The logs page (PR #64) ships this exact statement as 003_sent_time_index.sql.
-- Wrangler applies any file it hasn't recorded, by name, so whichever of the
-- two runs first creates the index and the other changes nothing. Keep the
-- name and columns identical to that file.

CREATE INDEX IF NOT EXISTS idx_sent_time ON sent(sent_at DESC, comment_id DESC);
