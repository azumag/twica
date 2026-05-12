-- Configure automatic gacha gifts for incoming raids.
ALTER TABLE streamers
  ADD COLUMN IF NOT EXISTS raid_gacha_draw_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE streamers
  DROP CONSTRAINT IF EXISTS streamers_raid_gacha_draw_count_check;

ALTER TABLE streamers
  ADD CONSTRAINT streamers_raid_gacha_draw_count_check
  CHECK (raid_gacha_draw_count BETWEEN 0 AND 10);

COMMENT ON COLUMN streamers.raid_gacha_draw_count IS
  'Number of gacha draws granted to the raider when an incoming raid is received. 0 disables raid gifts.';
