-- The logs page reads sends newest first, with comment_id breaking ties
-- inside a second. idx_sent_account_time only helps when one account is
-- picked, so without this every unfiltered page scans the whole table.

CREATE INDEX IF NOT EXISTS idx_sent_time ON sent(sent_at DESC, comment_id DESC);
