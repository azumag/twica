-- migration-transaction: required
-- migration-providers: planetscale
-- Issue #1783: カスタムレアリティごとの表示スタイル（色/グラデーション/グロー/エフェクト）。
--
-- 配信者がカスタムレアリティごとに表示スタイルを設定できるようにするため、
-- streamers に rarity_styles JSONB 列を追加する。
-- キーはレアリティ名、値は { color?, gradient?, glow?, effect? } オブジェクト。
-- 未設定時は空オブジェクト '{}'。

ALTER TABLE public.streamers
  ADD COLUMN IF NOT EXISTS rarity_styles JSONB NOT NULL DEFAULT '{}'::jsonb;
