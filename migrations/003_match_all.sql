-- Add match_all column to rules table to allow firing on every comment on a post
ALTER TABLE rules ADD COLUMN match_all INTEGER NOT NULL DEFAULT 0;
