-- Add a dedicated catalog of custom rarity names per streamer.
--
-- Why a separate column instead of reusing streamers.rarity_weights:
--   rarity_weights is overloaded (null = auto mode w/ defaults, {} = manual mode
--   sentinel, {...} = auto mode custom weights that must total 100% and trigger
--   a full drop_rate recalculation of every card). Storing rarity *names* there
--   would force auto mode and destructively recalculate drop rates just because
--   a streamer added a label. custom_rarities is fully decoupled: it only holds
--   the list of selectable custom rarity names and never affects drop rates.
--
-- Lock safety: a constant DEFAULT ('[]') means Postgres 11+ records the default
-- in catalog metadata without rewriting existing rows, so this ADD COLUMN takes
-- only a brief ACCESS EXCLUSIVE lock and needs no backfill.
--
-- Element-level validation (string, length 1-40, no control/Bidi chars, NFC,
-- de-duplication, no collision with default rarities) is enforced in the
-- application layer (POST /api/streamer/settings), consistent with how
-- rarity_weights keys and cards.rarity (migration 00048) are only structurally
-- constrained at the DB level.
--
-- Grants/RLS: migration 00047 grants SELECT on the streamers table to anon /
-- authenticated, which automatically covers this new column; writes go through
-- the service_role admin client only. No additional grants or RLS policies are
-- required.

ALTER TABLE streamers
ADD COLUMN IF NOT EXISTS custom_rarities JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 制約は再適用時に確実に張り直せるよう、一度落としてから追加する
-- （migration 00048 と同じ冪等パターン）。
ALTER TABLE streamers
DROP CONSTRAINT IF EXISTS streamers_custom_rarities_valid;

ALTER TABLE streamers
ADD CONSTRAINT streamers_custom_rarities_valid CHECK (
  jsonb_typeof(custom_rarities) = 'array'
  AND jsonb_array_length(custom_rarities) <= 50
);
