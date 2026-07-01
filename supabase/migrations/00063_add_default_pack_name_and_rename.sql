-- Issue #554: pack management improvements — renaming an existing pack
-- (cascading the new name across the catalog + every table that stores a
-- collection_name assignment) and a display-name override for the "default"
-- (unclassified) pseudo-pack. Also hardens the DB against the reserved `__`
-- namespace that #555's DEFAULT_PACK_SENTINEL ("__default__") relies on.
--
-- 課題 #554: 既存パックのリネーム（カタログ + 全紐付けテーブルへのカスケード）
-- と、デフォルト(未分類)パックの表示名オーバーライドを追加する。あわせて
-- #555 の DEFAULT_PACK_SENTINEL ("__default__") が依存する `__` 予約名前空間を
-- DB レベルでも保証する。

-- ---------------------------------------------------------------------------
-- a. Legacy-data collision guard.
--
-- `isReservedCollectionName` (the `__`-prefix guard for streamer-typed pack
-- names) was only introduced at the application layer in #555, AFTER this
-- feature had already shipped accepting free text (see #393/#269). If any
-- pre-#555 deployment let a streamer create a pack literally named e.g.
-- "__default__" on `cards.collection_name` or in `streamers.card_pack_names`,
-- that legacy row would (1) violate the new CHECK constraint added in (b)
-- below, causing this migration to fail loudly instead of silently, and more
-- importantly (2) collide with DEFAULT_PACK_SENTINEL's meaning ("unclassified
-- cards") if left in place. Fail the migration explicitly so an operator can
-- inspect and rename the offending rows by hand, rather than either (i)
-- crashing opaquely on the constraint below or (ii) silently corrupting the
-- default-pack semantics.
--
-- Intentionally NOT checked here: `streamers.channel_point_collection_name`
-- and `streamer_additional_gacha_rewards.collection_name`. After #555 shipped,
-- "__default__" is a legitimate, expected value in those two report-filter
-- columns (it means "the default pack only" — see DEFAULT_PACK_SENTINEL), so
-- scanning them for `__`-prefixed values would flag correct, current data as
-- if it were legacy corruption.
DO $$
DECLARE
  v_bad_cards INTEGER;
  v_bad_catalog INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_bad_cards
  FROM public.cards
  WHERE collection_name LIKE '\_\_%' ESCAPE '\';

  SELECT COUNT(*) INTO v_bad_catalog
  FROM public.streamers s,
       jsonb_array_elements_text(s.card_pack_names) AS pack_name
  WHERE pack_name LIKE '\_\_%' ESCAPE '\';

  IF v_bad_cards > 0 OR v_bad_catalog > 0 THEN
    RAISE EXCEPTION
      'Migration 00063 aborted: found % cards.collection_name row(s) and % streamers.card_pack_names entrie(s) using a reserved "__" prefix (legacy data predating the #555 isReservedCollectionName guard). Rename these manually before re-running this migration.',
      v_bad_cards, v_bad_catalog;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- b. DB-level guarantee that a card can never carry a reserved sentinel name.
-- This is defense-in-depth: the application layer already rejects `__`-
-- prefixed pack names at registration time (validateCardPackNamesInput /
-- isReservedCollectionName), so a card should never be able to reach this
-- state through the normal API. This constraint protects against a future
-- regression in that application-layer guard, or a direct/manual DB write.
ALTER TABLE public.cards
  DROP CONSTRAINT IF EXISTS cards_collection_name_not_reserved;

ALTER TABLE public.cards
  ADD CONSTRAINT cards_collection_name_not_reserved
  CHECK (collection_name IS NULL OR collection_name NOT LIKE '\_\_%' ESCAPE '\');

-- ---------------------------------------------------------------------------
-- c. streamers.default_card_pack_name: optional display-name override for the
-- "default" (unclassified, collection_name IS NULL) pseudo-pack. When unset,
-- the UI falls back to a generic label ("デフォルト" / "デフォルトパック").
-- This is a pure display string — it is NEVER written to
-- `cards.collection_name` (unclassified cards stay NULL) and is NOT part of
-- the `card_pack_names` catalog, so it needs no membership/uniqueness
-- validation against that list at the DB level (the API layer independently
-- validates it with the same character-class rules as a real pack name).
ALTER TABLE public.streamers
  ADD COLUMN IF NOT EXISTS default_card_pack_name TEXT NULL;

-- Same length/blank rule as the other pack-name-ish columns in 00061
-- (cards_collection_name_length / streamers_channel_point_collection_name_length):
-- NULL is allowed (falls back to the generic label), otherwise 1-80 chars
-- after trimming whitespace.
ALTER TABLE public.streamers
  DROP CONSTRAINT IF EXISTS streamers_default_card_pack_name_valid;

ALTER TABLE public.streamers
  ADD CONSTRAINT streamers_default_card_pack_name_valid
  CHECK (
    default_card_pack_name IS NULL
    OR char_length(btrim(default_card_pack_name)) BETWEEN 1 AND 80
  );

-- ---------------------------------------------------------------------------
-- d. rename_card_pack: atomically rename an existing catalog pack and cascade
-- the new name to every table that stores a collection_name assignment
-- scoped to that streamer. Without this, renaming a pack from the UI would
-- either require N separate round-trips (non-atomic — a crash mid-way would
-- leave some cards pointing at the old name, which is now nowhere in the
-- catalog) or a bespoke multi-statement transaction duplicated across the
-- API route. A single SQL function keeps the rename atomic and colocated
-- with the data it touches.
--
-- SECURITY INVOKER (not DEFINER): this function performs no privilege
-- escalation — it only needs the privileges of whichever role invokes it. In
-- this codebase, only the service_role admin client calls RPCs (see
-- src/lib/supabase/admin.ts), and service_role already has unrestricted
-- SELECT/INSERT/UPDATE/DELETE grants + "FOR ALL ... USING (true)" RLS
-- policies on streamers/cards/streamer_additional_gacha_rewards (see
-- 00001_initial_schema.sql, 00024_fix_rls_policies_security.sql,
-- 00008_add_streamer_additional_gacha_rewards.sql). Using INVOKER here avoids
-- the classic SECURITY DEFINER foot-gun (a function that runs as its
-- superuser-ish owner regardless of caller) when it isn't needed.
-- `SET search_path = ''` forces every reference to be schema-qualified
-- (`public.foo`), which is the current best-practice hardening against
-- search_path-injection attacks for both DEFINER and INVOKER functions.
--
-- Ownership/authorization of p_streamer_id (does the calling session actually
-- own this streamer?) is NOT re-checked here — that is the API route's
-- responsibility (PATCH /api/cards/collections verifies session ownership
-- BEFORE calling this RPC). Precisely because this function trusts its caller
-- unconditionally, EXECUTE is revoked from anon/authenticated below so it can
-- never be invoked directly through PostgREST's public RPC endpoint by an
-- arbitrary logged-in user passing someone else's streamer_id.
CREATE OR REPLACE FUNCTION public.rename_card_pack(
  p_streamer_id UUID,
  p_old_name TEXT,
  p_new_name TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_catalog JSONB;
  v_old_index INTEGER;
  v_new_name TEXT;
BEGIN
  -- Lock the streamer row for the duration of this transaction so a
  -- concurrent rename/catalog edit for the same streamer can't interleave
  -- with the read-modify-write below (classic lost-update race).
  SELECT card_pack_names INTO v_catalog
  FROM public.streamers
  WHERE id = p_streamer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'STREAMER_NOT_FOUND';
  END IF;

  -- Defense-in-depth re-validation of the new name (the API route already
  -- validates this with the same rules before calling in, but the function
  -- must not trust its caller for anything that affects data integrity).
  v_new_name := btrim(p_new_name);
  IF v_new_name IS NULL OR char_length(v_new_name) < 1 OR char_length(v_new_name) > 80 THEN
    RAISE EXCEPTION 'INVALID_NEW_NAME';
  END IF;

  IF v_new_name LIKE '\_\_%' ESCAPE '\' THEN
    RAISE EXCEPTION 'RESERVED_NEW_NAME';
  END IF;

  IF p_old_name = v_new_name THEN
    RAISE EXCEPTION 'OLD_NEW_NAME_IDENTICAL';
  END IF;

  -- old must be a currently-registered catalog entry (find its array index
  -- so we can replace it in place with jsonb_set, preserving ordering).
  SELECT ordinality - 1 INTO v_old_index
  FROM jsonb_array_elements_text(v_catalog) WITH ORDINALITY AS t(name, ordinality)
  WHERE t.name = p_old_name
  LIMIT 1;

  IF v_old_index IS NULL THEN
    RAISE EXCEPTION 'OLD_NAME_NOT_FOUND';
  END IF;

  -- new must NOT already be a catalog entry (renaming onto an existing pack
  -- would silently merge two distinct packs' cards together).
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(v_catalog) AS name WHERE name = v_new_name
  ) THEN
    RAISE EXCEPTION 'NEW_NAME_ALREADY_EXISTS';
  END IF;

  -- Replace the catalog entry in place (preserves display order) and cascade
  -- the rename to every table that stores a collection_name assignment
  -- scoped to this streamer. All four statements run inside this function's
  -- implicit transaction, so a mid-way failure rolls back everything.
  UPDATE public.streamers
  SET card_pack_names = jsonb_set(v_catalog, ARRAY[v_old_index::text], to_jsonb(v_new_name))
  WHERE id = p_streamer_id;

  UPDATE public.cards
  SET collection_name = v_new_name
  WHERE streamer_id = p_streamer_id AND collection_name = p_old_name;

  UPDATE public.streamers
  SET channel_point_collection_name = v_new_name
  WHERE id = p_streamer_id AND channel_point_collection_name = p_old_name;

  UPDATE public.streamer_additional_gacha_rewards
  SET collection_name = v_new_name
  WHERE streamer_id = p_streamer_id AND collection_name = p_old_name;

  -- NOTE (#557 follow-up, deliberately out of scope here): collection_completions
  -- also stores a collection_name reference (a per-user "completed this pack"
  -- record). It is intentionally NOT touched by this function yet — whether a
  -- completion earned under the old name should transfer to the renamed pack,
  -- or be forfeited, is a product decision that hasn't been made. A follow-up
  -- PR will CREATE OR REPLACE this function (same signature) to add that
  -- cascade once the semantics are decided, rather than guessing here.
END;
$$;

-- Only the service_role admin client (src/lib/supabase/admin.ts) is ever
-- allowed to call this RPC — see the SECURITY INVOKER comment above for why
-- unauthenticated callers must never reach it directly.
REVOKE ALL ON FUNCTION public.rename_card_pack(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rename_card_pack(UUID, TEXT, TEXT) TO service_role;
