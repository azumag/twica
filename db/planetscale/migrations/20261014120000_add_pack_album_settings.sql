-- migration-transaction: required
-- migration-providers: planetscale
-- #1765 フォローアップ: アルバム表示の制御。
--
-- 視聴者からの要望 (#1765「カードアルバム機能」) は当初 3×3 固定で実装された。
-- 本 migration はその制御に必要な配信者設定を追加する:
--   - pack_album_grid_sizes: コレクション(カードパック)ごとの既定の並び N (N×N)。
--     キーは __all__（すべてのパック / 個別指定が無いパックの既定）、
--     __default__（未分類のデフォルトパック）、または実パック名。
--   - collection_default_view: コレクションページの初期表示 ('grid' | 'album')。
--
-- 設計は pack_rarity_weights (#578) と同じ「streamers 上の JSONB マップ +
-- CHECK 制約の検証関数 + rename_card_pack のカスケード」に揃えている。
-- アプリ側の検証は src/lib/collection-album.ts が同じ規則を実装する。
--
-- Follow-up to #1765: per-collection album grid size (JSONB map keyed by
-- scope) + the collection page's default view mode, mirroring the
-- pack_rarity_weights design so display and persistence share one rule set.

ALTER TABLE public.streamers
  ADD COLUMN IF NOT EXISTS pack_album_grid_sizes JSONB DEFAULT NULL;

ALTER TABLE public.streamers
  ADD COLUMN IF NOT EXISTS collection_default_view TEXT NOT NULL DEFAULT 'grid';

ALTER TABLE public.streamers
  DROP CONSTRAINT IF EXISTS streamers_collection_default_view_valid;

ALTER TABLE public.streamers
  ADD CONSTRAINT streamers_collection_default_view_valid
  CHECK (collection_default_view IN ('grid', 'album'));

-- rename_card_pack (SET search_path = '') が streamers を UPDATE すると
-- CHECK 制約経由でこの関数が空 search_path 下で実行されるため、修飾名 +
-- search_path 固定でないと実行時名前解決に失敗する (00065 と同じ理由)。
CREATE OR REPLACE FUNCTION public.check_pack_album_grid_sizes_values(sizes JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  entry_key TEXT;
  entry_value JSONB;
  entry_count INTEGER;
BEGIN
  IF sizes IS NULL THEN
    RETURN TRUE;
  END IF;

  IF jsonb_typeof(sizes) <> 'object' THEN
    RETURN FALSE;
  END IF;

  -- 上限52件 = 事前登録パック上限50件(00062のCHECK) + __default__ + __all__ + 余裕1。
  SELECT COUNT(*) INTO entry_count FROM jsonb_object_keys(sizes);
  IF entry_count > 52 THEN
    RETURN FALSE;
  END IF;

  FOR entry_key IN SELECT jsonb_object_keys(sizes) LOOP
    entry_value := sizes -> entry_key;

    -- キーはパック名と同じ 1..80 文字（予約キーも同条件で通る）。
    IF char_length(entry_key) < 1 OR char_length(entry_key) > 80 THEN
      RETURN FALSE;
    END IF;

    -- 値は整数の N（3..12）。jsonb に jsonb→数値 のキャストは無いため、
    -- 正規化されたテキスト表現を経由して整数性と範囲を検証する
    -- （"3" は通し、"3.5" や "abc" は弾く）。
    IF (entry_value)::text !~ '^[0-9]+$' THEN
      RETURN FALSE;
    END IF;
    IF (entry_value)::text::integer < 3 OR (entry_value)::text::integer > 12 THEN
      RETURN FALSE;
    END IF;
  END LOOP;

  RETURN TRUE;
END;
$$;

ALTER TABLE public.streamers
  DROP CONSTRAINT IF EXISTS streamers_pack_album_grid_sizes_valid;

ALTER TABLE public.streamers
  ADD CONSTRAINT streamers_pack_album_grid_sizes_valid
  CHECK (public.check_pack_album_grid_sizes_values(pack_album_grid_sizes));

-- ---------------------------------------------------------------------------
-- rename_card_pack: 00063 で新設、00064/00065/20260907000000 でカスケード対象を
-- 拡張してきた RPC に、pack_album_grid_sizes のカスケードを追加する。
-- これが無いとパック名の変更でアルバム既定が旧名に取り残され、
-- (a) 旧名の設定は表示に使われず (b) 実パックは既定へフォールバックし、
-- 配信者が設定した値が黙って失われる。
-- ---------------------------------------------------------------------------
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

  -- Issue #557: carry per-pack completion achievements over to the new name
  -- (the follow-up 00063 explicitly deferred with its "#557 で対応予定" note).
  --
  -- ORDER MATTERS — DELETE must run BEFORE the UPDATE below. The partial
  -- unique index idx_collection_completions_pack_unique forbids two rows
  -- with the same (twitch_user_id, streamer_id, collection_name,
  -- total_cards). If some user already holds a completion recorded under
  -- v_new_name with the same total_cards (e.g. the new name was used by a
  -- previously-deleted pack, or an earlier rename cycled names), UPDATE-ing
  -- their old-name row to v_new_name would raise a unique violation and roll
  -- back the ENTIRE rename (catalog + cards + reward cascades above) because
  -- of an unrelated historical coincidence. So first DELETE exactly those
  -- old-name rows whose destination slot is already occupied — the surviving
  -- pre-existing new-name row already records the same achievement, so no
  -- information is lost — then UPDATE the remaining, collision-free rows.
  DELETE FROM public.collection_completions old_cc
  WHERE old_cc.streamer_id = p_streamer_id
    AND old_cc.collection_name = p_old_name
    AND EXISTS (
      SELECT 1
      FROM public.collection_completions new_cc
      WHERE new_cc.streamer_id = p_streamer_id
        AND new_cc.collection_name = v_new_name
        AND new_cc.twitch_user_id = old_cc.twitch_user_id
        AND new_cc.total_cards = old_cc.total_cards
    );

  UPDATE public.collection_completions
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

  -- Prefer the live source setting over an orphan using the destination name.
  DELETE FROM public.pack_completion_rewards WHERE streamer_id = p_streamer_id
    AND collection_name = v_new_name AND EXISTS (
      SELECT 1 FROM public.pack_completion_rewards WHERE streamer_id = p_streamer_id AND collection_name = p_old_name
    );
  UPDATE public.pack_completion_rewards SET collection_name = v_new_name, updated_at = now()
    WHERE streamer_id = p_streamer_id AND collection_name = p_old_name;
  -- Preserve historical facts when names have been reused; never abort rename.
  UPDATE public.pack_completion_reward_grants old_grant SET collection_name = v_new_name
    WHERE old_grant.streamer_id = p_streamer_id AND old_grant.collection_name = p_old_name
    AND NOT EXISTS (SELECT 1 FROM public.pack_completion_reward_grants destination
      WHERE destination.streamer_id = p_streamer_id AND destination.collection_name = v_new_name
      AND destination.twitch_user_id = old_grant.twitch_user_id);
  -- #1765 フォローアップ: carry forward the per-pack album grid size stored
  -- under the old name, if any. Same atomic move as pack_rarity_weights above
  -- (`- old` drops the key, `|| jsonb_build_object(...)` adds the new one in
  -- the same expression, so a crash can never leave both/neither). The `?`
  -- guard makes this a no-op for streamers that never set a default.
  UPDATE public.streamers
  SET pack_album_grid_sizes = (pack_album_grid_sizes - p_old_name) || jsonb_build_object(p_new_name, pack_album_grid_sizes -> p_old_name)
  WHERE id = p_streamer_id AND pack_album_grid_sizes ? p_old_name;

END;
$$;

-- Only the service_role admin client (src/lib/supabase/admin.ts) is ever
-- allowed to call this RPC — see the SECURITY INVOKER comment above for why
-- unauthenticated callers must never reach it directly.
REVOKE ALL ON FUNCTION public.rename_card_pack(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rename_card_pack(UUID, TEXT, TEXT) TO service_role;
