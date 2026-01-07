-- TwiCa Database Schema

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Streamers table (配信者)
CREATE TABLE streamers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  twitch_user_id TEXT UNIQUE NOT NULL,
  twitch_username TEXT NOT NULL,
  twitch_display_name TEXT NOT NULL,
  twitch_profile_image_url TEXT,
  channel_point_reward_id TEXT,
  channel_point_reward_name TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Cards table (カード)
CREATE TABLE cards (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  streamer_id UUID NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  rarity TEXT NOT NULL DEFAULT 'common' CHECK (rarity IN ('common', 'rare', 'epic', 'legendary')),
  drop_rate DECIMAL(5,4) NOT NULL DEFAULT 0.25 CHECK (drop_rate >= 0 AND drop_rate <= 1),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Users table (視聴者)
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  twitch_user_id TEXT UNIQUE NOT NULL,
  twitch_username TEXT NOT NULL,
  twitch_display_name TEXT NOT NULL,
  twitch_profile_image_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- User cards table (ユーザーの所有カード)
CREATE TABLE user_cards (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  obtained_at TIMESTAMPTZ DEFAULT NOW()
);

-- Gacha history table (ガチャ履歴)
CREATE TABLE gacha_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_twitch_id TEXT NOT NULL,
  user_twitch_username TEXT,
  card_id UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  streamer_id UUID NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  redeemed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_cards_streamer_id ON cards(streamer_id);
CREATE INDEX idx_cards_rarity ON cards(rarity);
CREATE INDEX idx_user_cards_user_id ON user_cards(user_id);
CREATE INDEX idx_user_cards_card_id ON user_cards(card_id);
CREATE INDEX idx_gacha_history_user_twitch_id ON gacha_history(user_twitch_id);
CREATE INDEX idx_gacha_history_streamer_id ON gacha_history(streamer_id);

-- Updated at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply updated_at triggers
CREATE TRIGGER update_streamers_updated_at
  BEFORE UPDATE ON streamers
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_cards_updated_at
  BEFORE UPDATE ON cards
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- RLS (Row Level Security) Policies
ALTER TABLE streamers ENABLE ROW LEVEL SECURITY;
ALTER TABLE cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE gacha_history ENABLE ROW LEVEL SECURITY;

-- Public read access for cards (for gacha display)
CREATE POLICY "Cards are viewable by everyone" ON cards
  FOR SELECT USING (is_active = true);

-- Streamers can manage their own cards
CREATE POLICY "Streamers can manage own cards" ON cards
  FOR ALL USING (
    streamer_id IN (
      SELECT id FROM streamers WHERE twitch_user_id = auth.jwt() ->> 'twitch_user_id'
    )
  );

-- Public read access for active streamers
CREATE POLICY "Active streamers are viewable by everyone" ON streamers
  FOR SELECT USING (is_active = true);

-- Streamers can update their own profile
CREATE POLICY "Streamers can update own profile" ON streamers
  FOR UPDATE USING (
    twitch_user_id = auth.jwt() ->> 'twitch_user_id'
  );

-- Users can view their own profile
CREATE POLICY "Users can view own profile" ON users
  FOR SELECT USING (
    twitch_user_id = auth.jwt() ->> 'twitch_user_id'
  );

-- Users can view their own cards
CREATE POLICY "Users can view own cards" ON user_cards
  FOR SELECT USING (
    user_id IN (
      SELECT id FROM users WHERE twitch_user_id = auth.jwt() ->> 'twitch_user_id'
    )
  );

-- Service role can insert gacha history
CREATE POLICY "Service can insert gacha history" ON gacha_history
  FOR INSERT WITH CHECK (true);

-- Users can view their own gacha history
CREATE POLICY "Users can view own gacha history" ON gacha_history
  FOR SELECT USING (
    user_twitch_id = auth.jwt() ->> 'twitch_user_id'
  );
