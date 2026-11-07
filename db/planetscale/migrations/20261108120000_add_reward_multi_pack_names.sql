-- migration-transaction: required
-- migration-providers: planetscale
-- Issue #1994: 1つのチャネルポイント報酬に複数のカードパックを割り当てられるようにする。
--
-- 新しい JSONB 配列列を2箇所へ追加する:
--   - streamers.channel_point_pack_names        : メイン報酬のパック割り当て
--   - streamer_additional_gacha_rewards.reward_pack_names : 追加報酬のパック割り当て
--
-- 意味づけ（src/lib/validation/collection-name.ts のコメントと一致させる）:
--   '[]'        → 全カード（現状どおり）
--   [x]         → 現行の単一パック経路
--   [x, y, ...] → 和集合プールからの抽選
--
-- 後方互換: 旧単一列（channel_point_collection_name / collection_name）には常に
-- 先頭要素をミラーして書き続ける。コードをロールバックしても「全カード抽選」へ
-- 落ちず、有効な1パックから抽選できるようにするため。既存データのバックフィルは
-- 不要（既定 '[]' は「旧列を見よ」の意味で、アプリ側 resolveEffectiveRewardPackNames
-- がフォールバックを吸収する）。
--
-- 上限 51 = 事前登録パック上限50（00062 の streamers_card_pack_names_valid）
-- + DEFAULT_PACK_SENTINEL（未分類カード擬似パック）1件。アプリ側定数
-- MAX_REWARD_PACK_NAMES（src/lib/validation/collection-name.ts）と必ず一致
-- させること（tests/unit/reward-multi-pack-names-migration.test.ts で検査）。

ALTER TABLE public.streamers
  ADD COLUMN IF NOT EXISTS channel_point_pack_names JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.streamers
  DROP CONSTRAINT IF EXISTS streamers_channel_point_pack_names_valid;

ALTER TABLE public.streamers
  ADD CONSTRAINT streamers_channel_point_pack_names_valid CHECK (
    jsonb_typeof(channel_point_pack_names) = 'array'
    AND jsonb_array_length(channel_point_pack_names) <= 51
  );

ALTER TABLE public.streamer_additional_gacha_rewards
  ADD COLUMN IF NOT EXISTS reward_pack_names JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.streamer_additional_gacha_rewards
  DROP CONSTRAINT IF EXISTS streamer_additional_gacha_rewards_reward_pack_names_valid;

ALTER TABLE public.streamer_additional_gacha_rewards
  ADD CONSTRAINT streamer_additional_gacha_rewards_reward_pack_names_valid CHECK (
    jsonb_typeof(reward_pack_names) = 'array'
    AND jsonb_array_length(reward_pack_names) <= 51
  );

-- ---------------------------------------------------------------------------
-- rename_card_pack: 00063 で新設、00064/00065/20260907000000/20261014120000 で
-- カスケード対象を拡張してきた RPC に、本 migration で追加した2つの配列列への
-- カスケードを追加する。これが無いとパック名の変更で報酬の複数パック割り当てが
-- 旧名に取り残され、(a) 設定画面は「登録解除済み」表示になり (b) 抽選は旧名の
-- パックを探して空プール/不一致になる。
--
-- 配列要素の置換は「順序を保ったまま重複除去」する。WITH ORDINALITY で元の
-- 位置を記録し、同名要素がリネームで他の既存要素と重なった場合は先頭出現を
-- 残す（アプリ側 resolveEffectiveRewardPackNames / resolveCollectionNamesField
-- と同じ重複除去規則。先頭要素は旧単一列へのミラー対象なので順序を変えない）。
-- GROUP BY name + MIN(ordinality) で先頭出現位置を採用し ORDER BY で並べ直す。
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

  -- Issue #1994: 新旧両方の列を更新する。新しい配列列内の要素も同じ規則で
  -- 置き換える（先頭出現を残す重複除去つき。`?` ガードで対象要素を含む行
  -- だけを UPDATE し、無関係な行への書き込みを避ける）。
  UPDATE public.streamers
  SET channel_point_pack_names = (
    SELECT jsonb_agg(name ORDER BY first_ord)
    FROM (
      SELECT CASE WHEN e.name = p_old_name THEN v_new_name ELSE e.name END AS name,
             MIN(e.ord) AS first_ord
      FROM jsonb_array_elements_text(channel_point_pack_names) WITH ORDINALITY AS e(name, ord)
      GROUP BY CASE WHEN e.name = p_old_name THEN v_new_name ELSE e.name END
    ) AS dedup(name, first_ord)
  )
  WHERE id = p_streamer_id AND channel_point_pack_names ? p_old_name;

  UPDATE public.streamer_additional_gacha_rewards
  SET reward_pack_names = (
    SELECT jsonb_agg(name ORDER BY first_ord)
    FROM (
      SELECT CASE WHEN e.name = p_old_name THEN v_new_name ELSE e.name END AS name,
             MIN(e.ord) AS first_ord
      FROM jsonb_array_elements_text(reward_pack_names) WITH ORDINALITY AS e(name, ord)
      GROUP BY CASE WHEN e.name = p_old_name THEN v_new_name ELSE e.name END
    ) AS dedup(name, first_ord)
  )
  WHERE streamer_id = p_streamer_id AND reward_pack_names ? p_old_name;

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
