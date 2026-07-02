-- Issue #578 (#576 Phase 1): per-pack rarity weight overrides — DB foundation.
--
-- This migration only adds storage + validation. It does NOT change drop_rate
-- calculation: effective per-pack weights are computed at DRAW TIME in a later
-- phase (#576 Phase 2), not recalculated/persisted here. Packs with no entry
-- in `pack_rarity_weights` keep inheriting the streamer's global
-- `rarity_weights` (application-layer convention, enforced when the weights
-- are actually consumed at draw time, not by this migration).
--
-- 課題 #578(#576 フェーズ1): パック別レアリティ重み上書きのDB基盤を追加する。
-- ここでは保存領域とバリデーションのみを追加し、drop_rate の再計算は一切
-- 行わない。実効的なパック別重みは後続フェーズ(#576 フェーズ2)で抽選時に
-- 計算する。`pack_rarity_weights` にエントリが無いパックは、配信者の
-- グローバル `rarity_weights` を引き続き継承する(アプリ層の規約であり、
-- 本マイグレーションでは強制しない)。

-- ---------------------------------------------------------------------------
-- a. streamers.rarity_weights_scope: 'global' (デフォルト、従来どおり単一の
-- rarity_weights を全パック共通で使う) か 'per_pack' (パックごとに
-- pack_rarity_weights のエントリを優先する) かを明示的に切り替えるフラグ。
--
-- Why an explicit enum column instead of overloading rarity_weights /
-- pack_rarity_weights null-ness as an implicit "mode" sentinel: migrations
-- 00028/00029 already demonstrated the pain of that approach for
-- rarity_weights itself — NULL's meaning was silently reinterpreted from
-- "manual mode" to "unset (falls back to auto-mode default)" between those
-- two migrations, requiring a one-off backfill to disambiguate legacy rows.
-- An explicit, self-describing column avoids re-litigating that same
-- null/{}-sentinel ambiguity for the new per-pack feature.
--
-- 明示カラム採用の理由: rarity_weights の null/{} センチネル多重化は
-- 00028/00029 で「NULLの意味の再解釈」という痛みが実証済み(手動モード明示
-- → 未設定/自動モードデフォルト化、で意味が変わり既存データの一括補正が
-- 必要になった)。同じ轍を踏まないよう、モード切替は素直な明示カラムとする。
ALTER TABLE streamers
ADD COLUMN IF NOT EXISTS rarity_weights_scope TEXT NOT NULL DEFAULT 'global';

ALTER TABLE streamers
DROP CONSTRAINT IF EXISTS streamers_rarity_weights_scope_valid;

ALTER TABLE streamers
ADD CONSTRAINT streamers_rarity_weights_scope_valid
CHECK (rarity_weights_scope IN ('global', 'per_pack'));

-- ---------------------------------------------------------------------------
-- b. streamers.pack_rarity_weights: per-pack override map, keyed by pack
-- name (a `streamers.card_pack_names` catalog entry) or the reserved
-- `__default__` sentinel (DEFAULT_PACK_SENTINEL, see
-- src/lib/validation/collection-name.ts) for the unclassified pseudo-pack.
-- Shape: { "<パック名>": {"common": 70, "rare": 20, ...}, "__default__": {...} }.
-- A pack with no entry here inherits the streamer's global `rarity_weights`
-- (application-layer convention — see the module comment above; not enforced
-- by this migration, which only validates shape/bounds).
--
-- Lock safety: DEFAULT NULL is a constant recorded in catalog metadata
-- (Postgres 11+), so this ADD COLUMN takes only a brief ACCESS EXCLUSIVE lock
-- and needs no backfill/rewrite of existing rows (same reasoning as
-- 00062's card_pack_names column comment).
ALTER TABLE streamers
ADD COLUMN IF NOT EXISTS pack_rarity_weights JSONB DEFAULT NULL;

-- Validate that pack_rarity_weights is either NULL or a JSON object whose
-- values are each themselves a valid rarity_weights object (reusing
-- check_rarity_weights_values from migration 00025 for the per-entry
-- 0-100/numeric-value validation, rather than duplicating that logic here).
--
-- Note: check_rarity_weights_values(NULL) returns TRUE by design (NULL is a
-- legitimate top-level rarity_weights value meaning "auto-mode disabled" —
-- see 00025/00028/00029). That means it alone cannot reject a pack entry that
-- is JSON null or a non-object (e.g. a string or array) — such a value would
-- silently pass straight through. This function therefore adds an explicit
-- `jsonb_typeof(entry) = 'object'` check per entry BEFORE delegating to
-- check_rarity_weights_values, closing that gap.
--
-- Key-existence validation (does each key actually correspond to a
-- registered card_pack_names entry or __default__?) is intentionally NOT
-- done here — same app-layer-only policy already established for
-- card_pack_names element validation (00062) and rarity_weights key
-- validation (00025): the DB only enforces shape/bounds, and the API route
-- (POST /api/streamer/settings) enforces catalog membership.
CREATE OR REPLACE FUNCTION check_pack_rarity_weights_values(weights JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  entry_key TEXT;
  entry_value JSONB;
  entry_count INTEGER;
BEGIN
  IF weights IS NULL THEN
    RETURN TRUE;
  END IF;

  IF jsonb_typeof(weights) <> 'object' THEN
    RETURN FALSE;
  END IF;

  -- 上限51件 = 事前登録パック上限50件(00062のCHECK) + __default__ 1件。
  SELECT COUNT(*) INTO entry_count FROM jsonb_object_keys(weights);
  IF entry_count > 51 THEN
    RETURN FALSE;
  END IF;

  FOR entry_key IN SELECT jsonb_object_keys(weights) LOOP
    entry_value := weights -> entry_key;

    -- check_rarity_weights_values(NULL) は TRUE を返す設計のため、ここで
    -- 明示的に object 型であることを確認しないと、JSON null や配列などの
    -- 非object値が誤って通ってしまう。
    IF jsonb_typeof(entry_value) <> 'object' THEN
      RETURN FALSE;
    END IF;

    IF NOT check_rarity_weights_values(entry_value) THEN
      RETURN FALSE;
    END IF;
  END LOOP;

  RETURN TRUE;
END;
$$;

ALTER TABLE streamers
DROP CONSTRAINT IF EXISTS streamers_pack_rarity_weights_valid;

ALTER TABLE streamers
ADD CONSTRAINT streamers_pack_rarity_weights_valid
CHECK (check_pack_rarity_weights_values(pack_rarity_weights));

-- ---------------------------------------------------------------------------
-- c. rename_card_pack: extend the #554 rename RPC (migration 00063) so that
-- renaming a catalog pack also carries forward any per-pack rarity-weight
-- override stored under the old name — otherwise a rename would silently
-- orphan the override (it would keep applying to a pack name that no longer
-- exists in the catalog, while the renamed pack would silently fall back to
-- the global weights). Full body copied from 00063 verbatim; the only change
-- is the new pack_rarity_weights cascade step added at the end, alongside the
-- existing cascades to cards / channel_point_collection_name /
-- streamer_additional_gacha_rewards. Issue #576/#578.
--
-- SECURITY INVOKER / SET search_path = '' / schema-qualification: unchanged
-- from 00063 — see that migration's comment for the full rationale (this
-- function performs no privilege escalation; only the service_role admin
-- client ever calls it, per the REVOKE/GRANT at the bottom of this block).
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
  -- scoped to this streamer. All statements run inside this function's
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

  -- Issue #576/#578: carry forward a per-pack rarity-weight override stored
  -- under the old name, if any. Move (not copy) the JSON entry atomically —
  -- `- p_old_name` drops the old key and `|| jsonb_build_object(...)` adds
  -- the new one in the same expression, so a mid-crash can never leave both
  -- keys present (which would be ambiguous) or neither (which would silently
  -- drop the override). The `pack_rarity_weights ? p_old_name` guard makes
  -- this a no-op when the streamer never customized this pack's weights
  -- (avoids writing a bogus `{}`-turned-object when the column is NULL).
  UPDATE public.streamers
  SET pack_rarity_weights = (pack_rarity_weights - p_old_name) || jsonb_build_object(v_new_name, pack_rarity_weights -> p_old_name)
  WHERE id = p_streamer_id AND pack_rarity_weights ? p_old_name;

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
