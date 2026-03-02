-- Migrate existing streamers with NULL rarity_weights to explicit manual mode ({})
-- 既存の rarity_weights=NULL を手動モード明示のセンチネル {} に一括更新
-- 背景: NULL のセマンティクスが「手動モード」から「未設定（自動モードデフォルト化）」に変更されたため、
-- 既存ユーザーの手動設定drop_rateが意図せず上書きされることを防止する
UPDATE streamers
SET rarity_weights = '{}'::jsonb
WHERE rarity_weights IS NULL;
