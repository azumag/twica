-- Migration: Add multiple gacha sound rules
-- ガチャ効果音を全体・レアリティ別・チャネルポイント報酬別に複数設定できるようにする
--
-- NOTE: 番号が 00053-00060 および 00061-00065 を飛ばしている理由:
-- 2026-05-31 本番障害後、00053-00058 はリポジトリから削除済み (#531)。
-- 00059/00060 は本番DBに適用済み（石交換マイグレーション）。
-- このマイグレーションは元々 00061 を使用していたが、main へのリベース時点で
-- 00061〜00065 は別マイグレーション（カードコレクション名、カードパック名等）に
-- 割り当て済みだったため、Issue #562 の番号衝突解消方針に従い、既存の最終番号
-- (00065) の次である 00066 に採番し直している (out-of-order 拒否を回避するため)。

ALTER TABLE streamers
ADD COLUMN IF NOT EXISTS gacha_sound_rules JSONB DEFAULT '[]'::jsonb NOT NULL;

COMMENT ON COLUMN streamers.gacha_sound_rules IS
  'Ordered gacha sound rules. Each rule contains url, enabled, targetType(all/rarity/reward), optional rarity, and optional rewardId.';
