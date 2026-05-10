-- Add optional per-streamer collection display name.
ALTER TABLE streamers
ADD COLUMN IF NOT EXISTS collection_name TEXT;

COMMENT ON COLUMN streamers.collection_name IS 'Optional display name for the streamer collection page. Null uses the default streamer-name based title.';
