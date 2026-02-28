-- Twitch API によるサブスク確認結果のキャッシュカラム追加
-- getUserPlan() はこのキャッシュ済み結果のみ参照し、Twitch API は直接呼ばない

ALTER TABLE users ADD COLUMN IF NOT EXISTS twitch_sub_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS twitch_has_sub BOOLEAN DEFAULT FALSE;
