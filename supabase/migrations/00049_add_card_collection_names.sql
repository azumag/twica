-- Allow streamers to split cards into named collections and bind gacha rewards
-- to a specific collection. NULL reward collection keeps the existing
-- "all cards" behavior for backwards compatibility.

ALTER TABLE cards
  ADD COLUMN IF NOT EXISTS collection_name TEXT;

ALTER TABLE cards
  ADD CONSTRAINT cards_collection_name_length
  CHECK (collection_name IS NULL OR char_length(collection_name) <= 80);

CREATE INDEX IF NOT EXISTS idx_cards_streamer_collection
  ON cards(streamer_id, collection_name)
  WHERE collection_name IS NOT NULL;

ALTER TABLE streamers
  ADD COLUMN IF NOT EXISTS channel_point_collection_name TEXT;

ALTER TABLE streamers
  ADD CONSTRAINT streamers_channel_point_collection_name_length
  CHECK (
    channel_point_collection_name IS NULL
    OR char_length(channel_point_collection_name) <= 80
  );

ALTER TABLE streamer_additional_gacha_rewards
  ADD COLUMN IF NOT EXISTS collection_name TEXT;

ALTER TABLE streamer_additional_gacha_rewards
  ADD CONSTRAINT streamer_additional_rewards_collection_name_length
  CHECK (collection_name IS NULL OR char_length(collection_name) <= 80);
