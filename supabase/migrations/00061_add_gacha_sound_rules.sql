-- Migration: Add multiple gacha sound rules
-- ガチャ効果音を全体・レアリティ別・チャネルポイント報酬別に複数設定できるようにする
--
-- NOTE: 番号が 00053-00060 を飛ばしている理由:
-- 2026-05-31 本番障害後、00053-00058 はリポジトリから削除済み (#531)。
-- 00059/00060 は本番DBに適用済み（石交換マイグレーション）。
-- このマイグレーションは 00060 の次の番号 00061 を使用して out-of-order を回避している。
-- (旧番号 00055 のまま追加すると Supabase が out-of-order として拒否する)

ALTER TABLE streamers
ADD COLUMN IF NOT EXISTS gacha_sound_rules JSONB DEFAULT '[]'::jsonb NOT NULL;

COMMENT ON COLUMN streamers.gacha_sound_rules IS
  'Ordered gacha sound rules. Each rule contains url, enabled, targetType(all/rarity/reward), optional rarity, and optional rewardId.';
