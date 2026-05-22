-- Add minimum-rarity guarantees for the final slot of multi-draw gacha rewards.
ALTER TABLE streamer_additional_gacha_rewards
  ADD COLUMN IF NOT EXISTS guaranteed_rarity TEXT NULL;

ALTER TABLE streamer_additional_gacha_rewards
  DROP CONSTRAINT IF EXISTS streamer_additional_gacha_rewards_guaranteed_rarity_check;

ALTER TABLE streamer_additional_gacha_rewards
  ADD CONSTRAINT streamer_additional_gacha_rewards_guaranteed_rarity_check
  CHECK (guaranteed_rarity IS NULL OR guaranteed_rarity IN ('rare', 'epic', 'legendary'));

COMMENT ON COLUMN streamer_additional_gacha_rewards.guaranteed_rarity IS
  'Minimum rarity guaranteed on the last draw of a multi-draw channel point reward. NULL disables the guarantee.';

ALTER TABLE streamers
  ADD COLUMN IF NOT EXISTS raid_gacha_guaranteed_rarity TEXT NULL;

ALTER TABLE streamers
  DROP CONSTRAINT IF EXISTS streamers_raid_gacha_guaranteed_rarity_check;

ALTER TABLE streamers
  ADD CONSTRAINT streamers_raid_gacha_guaranteed_rarity_check
  CHECK (raid_gacha_guaranteed_rarity IS NULL OR raid_gacha_guaranteed_rarity IN ('rare', 'epic', 'legendary'));

COMMENT ON COLUMN streamers.raid_gacha_guaranteed_rarity IS
  'Minimum rarity guaranteed on the last draw of a raid-triggered multi-draw gacha. NULL disables the guarantee.';
