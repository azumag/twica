-- カード内レアリティ重み: 同レアリティ内での排出確率配分を調整するための重み
-- デフォルト1.0（均等配分）。値が大きいほど同レアリティ内で出やすくなる。
-- 計算式: card_drop_rate = (rarity_pct / 100) * (intra_rarity_weight / SUM(intra_rarity_weight) in same rarity)
ALTER TABLE cards ADD COLUMN intra_rarity_weight NUMERIC NOT NULL DEFAULT 1.0;

-- 重みは正の数でなければならない（0は無効、負の値も不可）
ALTER TABLE cards ADD CONSTRAINT intra_rarity_weight_positive
  CHECK (intra_rarity_weight > 0);
