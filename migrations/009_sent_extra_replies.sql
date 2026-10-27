-- When a comment matches several rules, the first sends the DM. Meta allows
-- one private reply per comment but no such limit on public replies, so the
-- other matching rules can still post theirs, if their owner says so.
--
-- reply_without_dm: 1 lets this rule's public reply go out when another rule
-- sends the DM. Most replies say "Sent you a DM", which would then be false,
-- so it is opt-in, and 0 keeps every rule saved earlier replying only with
-- its own DM, as before.
--
-- sent_extra_replies: one row for each rule that matched a comment besides
-- the one that sent its DM, saying whether its public reply was posted and,
-- if not, why. A child table rather than a wider key on `sent`: one row per
-- comment in `sent`, keyed on comment_id, is what makes the DM exactly-once.
-- Here the key is (comment_id, rule_id), and a row is claimed with INSERT …
-- ON CONFLICT DO NOTHING before its reply is posted, so each rule's public
-- reply is exactly-once too. Rows are written in matching order, so rowid
-- keeps it. Existing comments have no rows, which reads as "no other rule
-- matched".

ALTER TABLE rules ADD COLUMN reply_without_dm INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS sent_extra_replies (
  comment_id TEXT NOT NULL,
  rule_id    INTEGER NOT NULL,
  status     TEXT NOT NULL,
  error      TEXT,
  sent_at    INTEGER NOT NULL,
  PRIMARY KEY (comment_id, rule_id)
);
