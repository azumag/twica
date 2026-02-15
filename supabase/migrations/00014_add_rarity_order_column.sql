-- Migration: Add rarity_order generated column for proper hierarchy sorting
-- レアリティ階層順ソート用のgenerated columnを追加
--
-- 背景:
-- Supabase JS client (PostgREST) はORDER BYにCASE式を使用できない。
-- rarityカラムを直接ソートするとアルファベット順(c→e→l→r)になり、
-- 意図したレアリティ階層(legendary→epic→rare→common)にならない。
--
-- 解決策:
-- GENERATED ALWAYS ASでレアリティ階層順の数値カラムを自動生成。
-- rarityカラムが更新されると自動的に再計算されるため、メンテナンス不要。
-- DB側でソート・ページネーションが完結し、全件取得が不要になる。

ALTER TABLE cards ADD COLUMN rarity_order SMALLINT GENERATED ALWAYS AS (
  CASE rarity
    WHEN 'legendary' THEN 1
    WHEN 'epic' THEN 2
    WHEN 'rare' THEN 3
    WHEN 'common' THEN 4
    ELSE 5
  END
) STORED;

-- Index for efficient sorting by rarity hierarchy
-- レアリティ階層順ソートの効率化用インデックス
CREATE INDEX idx_cards_rarity_order ON cards(rarity_order);

-- Drop the old rarity text index as it's no longer used
-- rarity text カラムのインデックスは不要になるため削除（rarity_orderを使用）
DROP INDEX IF EXISTS idx_cards_rarity;
