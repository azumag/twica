-- Store Twitch OAuth tokens outside users and only as application-encrypted ciphertext.

CREATE TABLE IF NOT EXISTS twitch_oauth_tokens (
  twitch_user_id TEXT PRIMARY KEY REFERENCES users(twitch_user_id) ON DELETE CASCADE,
  encrypted_access_token TEXT NOT NULL,
  encrypted_refresh_token TEXT NOT NULL,
  token_expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE twitch_oauth_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role can manage Twitch OAuth tokens" ON twitch_oauth_tokens;
CREATE POLICY "Service role can manage Twitch OAuth tokens"
ON twitch_oauth_tokens
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

CREATE OR REPLACE FUNCTION update_twitch_oauth_tokens_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_twitch_oauth_tokens_updated_at ON twitch_oauth_tokens;
CREATE TRIGGER update_twitch_oauth_tokens_updated_at
  BEFORE UPDATE ON twitch_oauth_tokens
  FOR EACH ROW
  EXECUTE FUNCTION update_twitch_oauth_tokens_updated_at();
