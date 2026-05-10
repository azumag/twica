-- Add chat sender settings and Twitch BOT accounts for chat announcements.
-- BOT OAuth tokens are isolated from streamers so future official BOT support
-- does not further expand the core streamer profile row.

CREATE TABLE IF NOT EXISTS twitch_bot_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_type TEXT NOT NULL CHECK (owner_type IN ('streamer', 'system')),
  streamer_id UUID REFERENCES streamers(id) ON DELETE CASCADE,
  twitch_user_id TEXT NOT NULL,
  twitch_username TEXT,
  twitch_display_name TEXT,
  twitch_access_token TEXT NOT NULL,
  twitch_refresh_token TEXT NOT NULL,
  twitch_token_expires_at TIMESTAMPTZ NOT NULL,
  scopes TEXT[] DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'error')),
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT twitch_bot_accounts_owner_shape CHECK (
    (owner_type = 'streamer' AND streamer_id IS NOT NULL)
    OR
    (owner_type = 'system' AND streamer_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_twitch_bot_accounts_streamer_owner
ON twitch_bot_accounts(streamer_id, owner_type)
WHERE owner_type = 'streamer';

CREATE UNIQUE INDEX IF NOT EXISTS idx_twitch_bot_accounts_system_user
ON twitch_bot_accounts(twitch_user_id)
WHERE owner_type = 'system';

CREATE INDEX IF NOT EXISTS idx_twitch_bot_accounts_status
ON twitch_bot_accounts(owner_type, status);

CREATE TABLE IF NOT EXISTS streamer_chat_sender_settings (
  streamer_id UUID PRIMARY KEY REFERENCES streamers(id) ON DELETE CASCADE,
  sender_mode TEXT NOT NULL DEFAULT 'streamer' CHECK (sender_mode IN ('streamer', 'custom_bot', 'official_bot')),
  custom_bot_account_id UUID REFERENCES twitch_bot_accounts(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT streamer_chat_sender_custom_bot_required CHECK (
    (sender_mode = 'custom_bot' AND custom_bot_account_id IS NOT NULL)
    OR
    (sender_mode <> 'custom_bot' AND custom_bot_account_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_streamer_chat_sender_custom_bot
ON streamer_chat_sender_settings(custom_bot_account_id);

ALTER TABLE twitch_bot_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE streamer_chat_sender_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can manage Twitch BOT accounts"
ON twitch_bot_accounts
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

CREATE POLICY "Service role can manage chat sender settings"
ON streamer_chat_sender_settings
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

CREATE TRIGGER update_twitch_bot_accounts_updated_at
  BEFORE UPDATE ON twitch_bot_accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_streamer_chat_sender_settings_updated_at
  BEFORE UPDATE ON streamer_chat_sender_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE twitch_bot_accounts IS 'Twitch BOT OAuth accounts used as chat announcement senders.';
COMMENT ON COLUMN twitch_bot_accounts.owner_type IS 'streamer = streamer-owned custom BOT, system = TwiCa official BOT.';
COMMENT ON TABLE streamer_chat_sender_settings IS 'Per-streamer chat announcement sender selection.';
COMMENT ON COLUMN streamer_chat_sender_settings.sender_mode IS 'streamer, custom_bot, or future official_bot sender mode.';
