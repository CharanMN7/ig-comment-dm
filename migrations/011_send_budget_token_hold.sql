-- Holds an account's DMs after Instagram says its token stopped working,
-- apart from paused_until, which holds them after Instagram says the account
-- is sending too fast. Reconnecting lifts this hold and leaves that one,
-- since a new token doesn't change how fast the account has been sending.
-- 0 for every row written before, which holds nothing.

ALTER TABLE send_budget ADD COLUMN token_held_until INTEGER NOT NULL DEFAULT 0;
