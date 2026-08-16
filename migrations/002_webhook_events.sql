-- Inbound Meta POSTs (including failed signatures) so Home can show whether
-- Instagram reached us. Keep this small; the Worker prunes old rows.

CREATE TABLE IF NOT EXISTS webhook_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at INTEGER NOT NULL,
  status      TEXT NOT NULL,
  object      TEXT,
  preview     TEXT,
  error       TEXT
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_time ON webhook_events(received_at DESC);
