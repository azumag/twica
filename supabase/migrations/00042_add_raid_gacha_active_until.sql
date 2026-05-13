-- Track the short-lived manual raid window used by raid-limited additional rewards.
ALTER TABLE streamers
  ADD COLUMN IF NOT EXISTS raid_gacha_active_until TIMESTAMPTZ;

COMMENT ON COLUMN streamers.raid_gacha_active_until IS
  'Manual raid-gacha activation window. Raid-limited additional rewards are blocked when this is null, invalid, or in the past.';
