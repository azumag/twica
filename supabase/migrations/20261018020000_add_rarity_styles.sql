-- Issue #1783: カスタムレアリティごとの表示スタイル。
-- streamers に rarity_styles JSONB 列を追加する。
ALTER TABLE streamers ADD COLUMN IF NOT EXISTS rarity_styles JSONB NOT NULL DEFAULT '{}'::jsonb;
