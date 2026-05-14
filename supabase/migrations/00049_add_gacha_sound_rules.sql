-- Migration: Add multiple gacha sound rules
-- ガチャ効果音を全体・レアリティ別・チャネルポイント報酬別に複数設定できるようにする

ALTER TABLE streamers
ADD COLUMN IF NOT EXISTS gacha_sound_rules JSONB DEFAULT '[]'::jsonb NOT NULL;

COMMENT ON COLUMN streamers.gacha_sound_rules IS
  'Ordered gacha sound rules. Each rule contains url, enabled, targetType(all/rarity/reward), optional rarity, and optional rewardId.';
