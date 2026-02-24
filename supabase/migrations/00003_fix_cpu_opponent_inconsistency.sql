-- Fix CPU opponent database inconsistency in battle system

-- Make opponent_card_id nullable
ALTER TABLE battles
ALTER COLUMN opponent_card_id DROP NOT NULL;

-- Add opponent_card_data column for storing CPU opponent data
ALTER TABLE battles
ADD COLUMN opponent_card_data JSONB;

-- Migrate existing data (if any)
-- Keep existing opponent_card_id values as they represent valid card references
-- For battles where opponent_card_id was incorrectly set, we'll need to fix them
-- This is a placeholder for any data migration logic if needed

-- Add comment for clarity
COMMENT ON COLUMN battles.opponent_card_id IS 'Card ID for player vs player battles. NULL for CPU battles. References cards(id).';
COMMENT ON COLUMN battles.opponent_card_data IS 'CPU opponent card data for CPU battles. Contains card details: id, name, hp, atk, def, spd, skill_type, skill_name, image_url, rarity.';