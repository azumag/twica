-- Issue #641: Raise the connected-gacha draw count ceiling from 10 to 15.
--
-- Two independent draw-count settings share the same fixed upper bound:
--   1. streamer_additional_gacha_rewards.draw_count (per-reward N-draw gacha)
--   2. streamers.raid_gacha_draw_count (auto gacha gift granted on incoming raid)
--
-- The owner explicitly confirmed a fixed limit of 15 is sufficient (issue
-- comment: "15固定でいい") rather than a per-streamer configurable cap, so
-- this migration only relaxes the two CHECK constraints introduced in
-- 00041_add_raid_gacha_reward_options.sql and 00043_add_raid_gacha_draw_count.sql.
-- Existing values (1-10 / 0-10) already satisfy the widened range, so no
-- data backfill is required.

ALTER TABLE streamer_additional_gacha_rewards
  DROP CONSTRAINT IF EXISTS streamer_additional_gacha_rewards_draw_count_check;

ALTER TABLE streamer_additional_gacha_rewards
  ADD CONSTRAINT streamer_additional_gacha_rewards_draw_count_check
  CHECK (draw_count BETWEEN 1 AND 15);

ALTER TABLE streamers
  DROP CONSTRAINT IF EXISTS streamers_raid_gacha_draw_count_check;

ALTER TABLE streamers
  ADD CONSTRAINT streamers_raid_gacha_draw_count_check
  CHECK (raid_gacha_draw_count BETWEEN 0 AND 15);

-- Refresh the column doc comment from 00041 so it doesn't keep advertising
-- the old "10 max" ceiling now that the CHECK constraint allows up to 15.
COMMENT ON COLUMN streamer_additional_gacha_rewards.draw_count IS
  'Number of cards granted by this additional channel point reward. 1 = normal gacha, 15 max.';
