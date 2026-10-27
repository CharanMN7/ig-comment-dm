-- Answers "had this person been sent a DM before?" from the index alone, so
-- Home's all-time people reached can add today's new people to the nightly
-- snapshot without reading the history. Partial: only rows where a DM went
-- out are in it, so it costs one extra row written per DM sent, and nothing
-- for skipped or failed comments.

CREATE INDEX IF NOT EXISTS idx_sent_reached ON sent(commenter_id, ig_user_id, sent_at) WHERE dm_status = 'ok';
