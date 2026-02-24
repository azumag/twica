-- Migration: Add streamer_additional_gacha_rewards table
-- Purpose: Allow streamers to configure multiple channel point rewards for gacha triggers
-- The main reward remains in streamers.channel_point_reward_id for backward compatibility
-- Additional rewards are stored in this table

-- Create the additional gacha rewards table
CREATE TABLE IF NOT EXISTS streamer_additional_gacha_rewards (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Reference to the streamer (cascade delete when streamer is removed)
  streamer_id UUID NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  -- Twitch reward ID for the additional trigger
  reward_id TEXT NOT NULL,
  -- Human-readable reward name for display purposes
  reward_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  -- Each reward can only be registered once per streamer
  UNIQUE (streamer_id, reward_id)
);

-- Index for efficient lookups by streamer_id (used when fetching all rewards for a streamer)
CREATE INDEX IF NOT EXISTS idx_additional_gacha_rewards_streamer_id
ON streamer_additional_gacha_rewards(streamer_id);

-- Index for efficient lookups by reward_id (used in EventSub webhook handler)
CREATE INDEX IF NOT EXISTS idx_additional_gacha_rewards_reward_id
ON streamer_additional_gacha_rewards(reward_id);

-- Enable Row Level Security
ALTER TABLE streamer_additional_gacha_rewards ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Allow service role full access (for server-side operations)
CREATE POLICY "Service role can manage additional rewards"
ON streamer_additional_gacha_rewards
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- RLS Policy: Allow authenticated users to read their own additional rewards
-- (Streamers can only see their own additional reward configurations)
CREATE POLICY "Users can read own additional rewards"
ON streamer_additional_gacha_rewards
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM streamers
    WHERE streamers.id = streamer_additional_gacha_rewards.streamer_id
    AND streamers.twitch_user_id = auth.uid()::text
  )
);
