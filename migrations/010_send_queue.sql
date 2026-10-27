-- The send queue. A matched comment's row is written as 'queued' when no DM
-- can go out right away (the account has used its share of Instagram's hourly
-- limit, or the webhook is out of time), and the every-minute cron sends it
-- later. Every row written before this keeps attempts 0 and no
-- next_attempt_at, and isn't queued, so nothing old is ever sent.

-- How many DM calls this row has made, which may include one Instagram never answered.
ALTER TABLE sent ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
-- 'queued' or 'retry': not sent before this. 'pending': the lease, after
-- which a send that never recorded its outcome is given up on.
ALTER TABLE sent ADD COLUMN next_attempt_at INTEGER;
-- When the comment was made, for Instagram's 7-day limit on private replies.
ALTER TABLE sent ADD COLUMN comment_at INTEGER;
-- For {username} when a queued DM goes out, since the webhook payload is gone by then.
ALTER TABLE sent ADD COLUMN username TEXT;

-- Partial, so only rows waiting to be sent are in them. The cron reads the
-- oldest few per account each minute, and the stuck sends, without touching
-- the history.
CREATE INDEX IF NOT EXISTS idx_sent_queue ON sent(ig_user_id, next_attempt_at) WHERE dm_status IN ('queued', 'retry');
CREATE INDEX IF NOT EXISTS idx_sent_lease ON sent(next_attempt_at) WHERE dm_status = 'pending';

-- DM calls per account in the current one-minute window. 12 a minute keeps
-- any hour under Instagram's 750. paused_until holds DMs back
-- after Instagram says the account is sending too fast.
CREATE TABLE IF NOT EXISTS send_budget (
  ig_user_id   TEXT PRIMARY KEY,
  minute       INTEGER NOT NULL,
  used         INTEGER NOT NULL,
  paused_until INTEGER NOT NULL DEFAULT 0
);
