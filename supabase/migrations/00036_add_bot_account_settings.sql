-- Add optional Twitch BOT account settings for chat announcements.
-- BOT tokens are stored on streamers because this is a 1:1 optional setting.

ALTER TABLE streamers
  ADD COLUMN IF NOT EXISTS bot_twitch_user_id TEXT,
  ADD COLUMN IF NOT EXISTS bot_twitch_username TEXT,
  ADD COLUMN IF NOT EXISTS bot_twitch_display_name TEXT,
  ADD COLUMN IF NOT EXISTS bot_twitch_access_token TEXT,
  ADD COLUMN IF NOT EXISTS bot_twitch_refresh_token TEXT,
  ADD COLUMN IF NOT EXISTS bot_twitch_token_expires_at TIMESTAMPTZ;

COMMENT ON COLUMN streamers.bot_twitch_user_id IS 'Optional Twitch user ID used as the chat announcement sender.';
COMMENT ON COLUMN streamers.bot_twitch_username IS 'Optional Twitch login name for the chat announcement BOT account.';
COMMENT ON COLUMN streamers.bot_twitch_display_name IS 'Optional Twitch display name for the chat announcement BOT account.';
COMMENT ON COLUMN streamers.bot_twitch_access_token IS 'OAuth access token for the chat announcement BOT account.';
COMMENT ON COLUMN streamers.bot_twitch_refresh_token IS 'OAuth refresh token for the chat announcement BOT account.';
COMMENT ON COLUMN streamers.bot_twitch_token_expires_at IS 'Expiration timestamp for the chat announcement BOT access token.';
