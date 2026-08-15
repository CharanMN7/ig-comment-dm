-- SQLite / D1. Timestamps are INTEGER unix epoch seconds.

CREATE TABLE IF NOT EXISTS accounts (
  ig_user_id        TEXT PRIMARY KEY,
  username          TEXT NOT NULL,
  access_token_enc  TEXT NOT NULL,
  token_iv          TEXT NOT NULL,
  token_expires_at  INTEGER NOT NULL,
  active            INTEGER NOT NULL DEFAULT 1,
  connected_at      INTEGER NOT NULL,
  last_refreshed_at INTEGER,
  needs_reconnect   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rules (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ig_user_id        TEXT NOT NULL REFERENCES accounts(ig_user_id) ON DELETE CASCADE,
  label             TEXT NOT NULL,
  keywords          TEXT NOT NULL,
  media_id          TEXT,
  dm_text           TEXT NOT NULL,
  public_reply_text TEXT,
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sent (
  comment_id   TEXT PRIMARY KEY,
  ig_user_id   TEXT NOT NULL,
  rule_id      INTEGER,
  commenter_id TEXT,
  dm_status    TEXT NOT NULL,
  reply_status TEXT,
  error        TEXT,
  sent_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS system (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_sent_account_time ON sent(ig_user_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_rules_account_active ON rules(ig_user_id, active);
