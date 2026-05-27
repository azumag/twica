-- Allow streamers to define custom rarity labels on cards.
-- Existing fixed rarities remain the default UI presets, but cards.rarity is no
-- longer restricted to only common/rare/epic/legendary.

ALTER TABLE cards
DROP CONSTRAINT IF EXISTS cards_rarity_check;

ALTER TABLE cards
ADD CONSTRAINT cards_rarity_not_blank
CHECK (
  length(btrim(rarity)) BETWEEN 1 AND 40
  AND rarity !~ '[[:cntrl:]]'
);
