-- Add battle functionality to TwiCa

-- Add battle stats to cards table
ALTER TABLE cards
ADD COLUMN hp INTEGER DEFAULT 100,
ADD COLUMN atk INTEGER DEFAULT 30,
ADD COLUMN def INTEGER DEFAULT 15,
ADD COLUMN spd INTEGER DEFAULT 5,
ADD COLUMN skill_type TEXT DEFAULT 'attack' CHECK (skill_type IN ('attack', 'defense', 'heal', 'special')),
ADD COLUMN skill_name TEXT DEFAULT '通常攻撃',
ADD COLUMN skill_power INTEGER DEFAULT 10;

-- Battles table (対戦履歴)
CREATE TABLE battles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_card_id UUID NOT NULL REFERENCES user_cards(id) ON DELETE CASCADE,
    opponent_card_id UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    result TEXT NOT NULL CHECK (result IN ('win', 'lose', 'draw')),
    turn_count INTEGER DEFAULT 0,
    battle_log JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Battle stats table (対戦統計)
CREATE TABLE battle_stats (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
    total_battles INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    draws INTEGER DEFAULT 0,
    win_rate DECIMAL(5, 2) DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for battle tables
CREATE INDEX idx_battles_user_id ON battles(user_id);
CREATE INDEX idx_battles_created_at ON battles(created_at DESC);
CREATE INDEX idx_battles_result ON battles(result);
CREATE INDEX idx_battle_stats_user_id ON battle_stats(user_id);

-- Trigger to update battle_stats
CREATE OR REPLACE FUNCTION update_battle_stats()
RETURNS TRIGGER AS $$
BEGIN
    -- Update or insert battle stats for the user
    INSERT INTO battle_stats (
        user_id, 
        total_battles, 
        wins, 
        losses, 
        draws, 
        win_rate,
        updated_at
    ) VALUES (
        NEW.user_id,
        1,
        CASE WHEN NEW.result = 'win' THEN 1 ELSE 0 END,
        CASE WHEN NEW.result = 'lose' THEN 1 ELSE 0 END,
        CASE WHEN NEW.result = 'draw' THEN 1 ELSE 0 END,
        CASE WHEN NEW.result = 'win' THEN 100.0 ELSE 0.0 END,
        NOW()
    )
    ON CONFLICT (user_id) DO UPDATE SET
        total_battles = battle_stats.total_battles + 1,
        wins = battle_stats.wins + CASE WHEN NEW.result = 'win' THEN 1 ELSE 0 END,
        losses = battle_stats.losses + CASE WHEN NEW.result = 'lose' THEN 1 ELSE 0 END,
        draws = battle_stats.draws + CASE WHEN NEW.result = 'draw' THEN 1 ELSE 0 END,
        win_rate = ROUND(
            (battle_stats.wins + CASE WHEN NEW.result = 'win' THEN 1 ELSE 0 END) * 100.0 / 
            (battle_stats.total_battles + 1)::DECIMAL, 2
        ),
        updated_at = NOW();
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to battles table
CREATE TRIGGER update_battle_stats_trigger
    AFTER INSERT ON battles
    FOR EACH ROW
    EXECUTE FUNCTION update_battle_stats();

-- Apply updated_at trigger to battle_stats
CREATE TRIGGER update_battle_stats_updated_at
    BEFORE UPDATE ON battle_stats
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Enable RLS for new tables
ALTER TABLE battles ENABLE ROW LEVEL SECURITY;
ALTER TABLE battle_stats ENABLE ROW LEVEL SECURITY;

-- RLS Policies for battles table
CREATE POLICY "Service can manage battles" ON battles
    FOR ALL USING (true);

-- RLS Policies for battle_stats table  
CREATE POLICY "Service can manage battle_stats" ON battle_stats
    FOR ALL USING (true);