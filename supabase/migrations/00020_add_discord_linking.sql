-- Discord連携用カラムを users テーブルに追加
-- Twitch-Discord統合によるサブスクライバーロール判定に使用
-- 既存の twitch_access_token 等と一貫したパターン

ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_user_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_access_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_refresh_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_token_expires_at TIMESTAMPTZ;
-- サブスクロール最終確認日時（1時間キャッシュ用: ロールの有無に関わらず更新）
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_sub_verified_at TIMESTAMPTZ;
-- 最終チェック時にサブスクライバーロールを持っていたか（キャッシュ判定用）
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_has_sub_role BOOLEAN NOT NULL DEFAULT false;

-- Discord ユーザーID でのルックアップ用インデックス
CREATE INDEX IF NOT EXISTS idx_users_discord_user_id ON users (discord_user_id) WHERE discord_user_id IS NOT NULL;
