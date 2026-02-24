-- Add Twitch token columns to users table
-- Migration: 00004_add_twitch_tokens_to_users.sql

-- Add columns for Twitch token storage
ALTER TABLE users ADD COLUMN IF NOT EXISTS twitch_access_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS twitch_refresh_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS twitch_token_expires_at TIMESTAMP WITH TIME ZONE;

-- Ensure RLS is enabled on users table
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- Create policy for updating own twitch tokens
-- Policies for RLS (actual operations use admin client which bypasses RLS)
CREATE POLICY "Users can update own twitch tokens"
ON users FOR UPDATE
USING (auth.uid()::text = twitch_user_id)
WITH CHECK (auth.uid()::text = twitch_user_id);

-- Create policy for reading own twitch tokens
-- Policies for RLS (actual operations use admin client which bypasses RLS)
CREATE POLICY "Users can read own twitch tokens"
ON users FOR SELECT
USING (auth.uid()::text = twitch_user_id);
