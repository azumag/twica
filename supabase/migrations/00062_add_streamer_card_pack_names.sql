-- Add a pre-defined catalog of card pack names per streamer.
--
-- Why a separate column instead of relying on distinct cards.collection_name
-- values: the card-pack feature (#393) originally let streamers type a pack
-- name freehand on any card, which implicitly "created" a pack. Per streamer
-- feedback, pack names must now be curated ahead of time (a dropdown, not
-- free text), mirroring custom_rarities (migration 00049): a dedicated JSONB
-- list the streamer manages independently of any specific card.
--
-- cards.collection_name / streamers.channel_point_collection_name /
-- streamer_additional_gacha_rewards.collection_name are unchanged — they
-- still hold "which pack does this card/reward belong to". What changes is
-- where the set of VALID pack names comes from.
--
-- Lock safety: a constant DEFAULT ('[]') means Postgres 11+ records the
-- default in catalog metadata without rewriting existing rows, so this ADD
-- COLUMN takes only a brief ACCESS EXCLUSIVE lock and needs no backfill.
--
-- Element-level validation (string, length 1-80, no control/Bidi chars,
-- de-duplication) is enforced in the application layer
-- (POST /api/streamer/settings), consistent with custom_rarities.
--
-- Grants/RLS: migration 00047 grants SELECT on the streamers table to anon /
-- authenticated, which automatically covers this new column; writes go
-- through the service_role admin client only. No additional grants or RLS
-- policies are required.

ALTER TABLE streamers
ADD COLUMN IF NOT EXISTS card_pack_names JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 制約は再適用時に確実に張り直せるよう、一度落としてから追加する
-- （migration 00049 と同じ冪等パターン）。
ALTER TABLE streamers
DROP CONSTRAINT IF EXISTS streamers_card_pack_names_valid;

ALTER TABLE streamers
ADD CONSTRAINT streamers_card_pack_names_valid CHECK (
  jsonb_typeof(card_pack_names) = 'array'
  AND jsonb_array_length(card_pack_names) <= 50
);
