-- Add per-reward options for raid-limited and multi-draw gacha triggers.
ALTER TABLE streamer_additional_gacha_rewards
  ADD COLUMN IF NOT EXISTS draw_count INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS is_raid_limited BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE streamer_additional_gacha_rewards
  DROP CONSTRAINT IF EXISTS streamer_additional_gacha_rewards_draw_count_check;

ALTER TABLE streamer_additional_gacha_rewards
  ADD CONSTRAINT streamer_additional_gacha_rewards_draw_count_check
  CHECK (draw_count BETWEEN 1 AND 10);

COMMENT ON COLUMN streamer_additional_gacha_rewards.draw_count IS
  'Number of cards granted by this additional channel point reward. 1 = normal gacha, 10 max.';

COMMENT ON COLUMN streamer_additional_gacha_rewards.is_raid_limited IS
  'Marks this additional reward as a raid-limited gacha trigger for streamer-facing management.';
