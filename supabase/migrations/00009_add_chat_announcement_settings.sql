-- チャット通知設定をstreamersテーブルに追加
-- Add chat announcement settings to streamers table

-- ガチャ結果をTwitchチャットに通知する機能の設定
-- Settings for announcing gacha results to Twitch chat

-- chat_announcement_enabled: チャット通知の有効/無効フラグ（デフォルトはfalse、オプトイン方式）
-- chat_announcement_template: 通知メッセージのカスタムテンプレート（nullの場合はデフォルトテンプレートを使用）

ALTER TABLE streamers
ADD COLUMN IF NOT EXISTS chat_announcement_enabled BOOLEAN DEFAULT FALSE NOT NULL,
ADD COLUMN IF NOT EXISTS chat_announcement_template TEXT DEFAULT NULL;

COMMENT ON COLUMN streamers.chat_announcement_enabled IS 'Whether to post gacha results to Twitch chat (default: false, opt-in)';
COMMENT ON COLUMN streamers.chat_announcement_template IS 'Custom message template for chat announcements. Placeholders: {user}, {card}, {rarity}, {url}, {detail}, {num}';

-- ユーザーに付与されたTwitchスコープを追跡するカラムを追加
-- Add column to track granted Twitch scopes for users
-- 新規ユーザーはコールバック時にスコープが保存される
-- 既存ユーザーは空配列（デフォルト値）で、追加スコープが必要な場合は再認証が必要

ALTER TABLE users
ADD COLUMN IF NOT EXISTS twitch_scopes TEXT[] DEFAULT '{}';

COMMENT ON COLUMN users.twitch_scopes IS 'Array of Twitch OAuth scopes granted to this user. Empty for existing users until re-authentication.';
