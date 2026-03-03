-- 全ストリーマーのデフォルトを自動モードに変更
-- migration 00028 で {} (手動モード) に設定されたストリーマーを
-- DEFAULT_RARITY_WEIGHTS (自動モード) に更新する
-- 既にカスタム値を設定済みのストリーマーは影響を受けない
UPDATE streamers
SET rarity_weights = '{"common": 70, "rare": 20, "epic": 8, "legendary": 2}'::jsonb
WHERE rarity_weights = '{}'::jsonb OR rarity_weights IS NULL;
