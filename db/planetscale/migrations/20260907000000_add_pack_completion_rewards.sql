-- migration-transaction: required
-- migration-providers: planetscale
-- #720: Set-external bonuses. Inactive cards are excluded from BOTH overall
-- and per-pack completion, before and after receipt. PlanetScale uses the
-- existing service_role membership; no retired PostgREST runtime is required.
CREATE TABLE public.pack_completion_rewards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  streamer_id uuid NOT NULL REFERENCES public.streamers(id) ON DELETE CASCADE,
  collection_name text NOT NULL,
  reward_card_id uuid NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (streamer_id, collection_name)
);
CREATE INDEX pack_completion_rewards_card_idx ON public.pack_completion_rewards(reward_card_id);
CREATE TABLE public.pack_completion_reward_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  twitch_user_id text NOT NULL,
  streamer_id uuid NOT NULL REFERENCES public.streamers(id) ON DELETE CASCADE,
  collection_name text NOT NULL,
  -- Historical identity survives deletion of the awarded card.
  reward_card_id uuid NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (twitch_user_id, streamer_id, collection_name)
);
CREATE INDEX pack_completion_reward_grants_streamer_idx
  ON public.pack_completion_reward_grants(streamer_id, collection_name);
REVOKE ALL ON TABLE public.pack_completion_rewards, public.pack_completion_reward_grants FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.pack_completion_rewards, public.pack_completion_reward_grants TO service_role;

CREATE FUNCTION public.set_pack_completion_reward(p_streamer_id uuid, p_collection_name text, p_reward_card_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE v_active boolean; v_catalog jsonb;
BEGIN
  -- Same lock ordering as rename_card_pack: streamer, then cards, then settings.
  -- This also rechecks catalog membership if the API read preceded a rename.
  SELECT card_pack_names INTO v_catalog FROM public.streamers WHERE id = p_streamer_id FOR UPDATE;
  IF NOT FOUND OR p_collection_name IS NULL OR
    (p_collection_name <> '__default__' AND NOT coalesce(v_catalog ? p_collection_name, false)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pack_not_found');
  END IF;
  SELECT is_active INTO v_active FROM public.cards
    WHERE id = p_reward_card_id AND streamer_id = p_streamer_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'card_not_found'); END IF;
  IF v_active IS DISTINCT FROM false THEN RETURN jsonb_build_object('ok', false, 'reason', 'card_active'); END IF;
  INSERT INTO public.pack_completion_rewards(streamer_id, collection_name, reward_card_id)
    VALUES (p_streamer_id, p_collection_name, p_reward_card_id)
    ON CONFLICT (streamer_id, collection_name) DO UPDATE
      SET reward_card_id = EXCLUDED.reward_card_id, updated_at = now();
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE FUNCTION public.prevent_activating_reward_card() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE v_pack text;
BEGIN
  -- UPDATE already holds the same card lock as the setting RPC. A fresh
  -- statement snapshot in this VOLATILE trigger sees a committed setting even
  -- when UPDATE started while that RPC held the lock.
  IF NEW.is_active IS DISTINCT FROM false OR NEW.streamer_id IS DISTINCT FROM OLD.streamer_id THEN
    SELECT collection_name INTO v_pack FROM public.pack_completion_rewards WHERE reward_card_id = OLD.id LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0720', MESSAGE = 'PACK_COMPLETION_REWARD_CARD', DETAIL = v_pack;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER prevent_activating_reward_card BEFORE UPDATE OF is_active, streamer_id ON public.cards
  FOR EACH ROW EXECUTE FUNCTION public.prevent_activating_reward_card();

CREATE FUNCTION public.grant_pack_completion_reward(p_twitch_user_id text, p_streamer_id uuid,
  p_collection_name text, p_reward_card_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE v_user_id uuid; v_card_id uuid; v_grant_id uuid; v_total integer; v_missing integer;
BEGIN
  SELECT id INTO v_user_id FROM public.users WHERE twitch_user_id = p_twitch_user_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('granted', false, 'reason', 'user_not_found'); END IF;
  -- Serialize with settings and rename. Revalidate the configured card rather
  -- than trusting a cached application result after a replacement or removal.
  PERFORM id FROM public.streamers WHERE id = p_streamer_id FOR UPDATE;
  SELECT reward_card_id INTO v_card_id FROM public.pack_completion_rewards
    WHERE streamer_id = p_streamer_id AND collection_name = p_collection_name;
  IF NOT FOUND OR v_card_id IS DISTINCT FROM p_reward_card_id THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'setting_changed');
  END IF;
  IF EXISTS (SELECT 1 FROM public.pack_completion_reward_grants WHERE twitch_user_id = p_twitch_user_id
    AND streamer_id = p_streamer_id AND collection_name = p_collection_name) THEN
    RETURN jsonb_build_object('granted', false, 'already_granted', true);
  END IF;
  -- One statement observes a consistent set and ownership. The bonus is never
  -- in this set, so it cannot be its own prerequisite. No historical completion
  -- record is consulted; added cards require current full ownership again.
  SELECT count(*), count(*) FILTER (WHERE NOT EXISTS (
    SELECT 1 FROM public.user_cards uc WHERE uc.user_id = v_user_id AND uc.card_id = c.id
  )) INTO v_total, v_missing FROM public.cards c
  WHERE c.streamer_id = p_streamer_id AND c.is_active IS TRUE
    AND ((p_collection_name = '__default__' AND c.collection_name IS NULL) OR c.collection_name = p_collection_name);
  IF v_total = 0 OR v_missing > 0 THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'incomplete');
  END IF;
  INSERT INTO public.pack_completion_reward_grants(twitch_user_id, streamer_id, collection_name, reward_card_id)
    VALUES (p_twitch_user_id, p_streamer_id, p_collection_name, v_card_id)
    ON CONFLICT (twitch_user_id, streamer_id, collection_name) DO NOTHING RETURNING id INTO v_grant_id;
  IF v_grant_id IS NULL THEN RETURN jsonb_build_object('granted', false, 'already_granted', true); END IF;
  -- Issuance limits govern random draws only. This guaranteed, once-per-pack
  -- award intentionally does not inspect max_issuance_count.
  INSERT INTO public.user_cards(user_id, card_id) VALUES (v_user_id, v_card_id);
  RETURN jsonb_build_object('granted', true, 'already_granted', false);
END;
$$;
REVOKE ALL ON FUNCTION public.set_pack_completion_reward(uuid,text,uuid), public.grant_pack_completion_reward(text,uuid,text,uuid), public.prevent_activating_reward_card() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_pack_completion_reward(uuid,text,uuid), public.grant_pack_completion_reward(text,uuid,text,uuid), public.prevent_activating_reward_card() TO service_role;

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
END;
$$;

-- Only the service_role admin client (src/lib/supabase/admin.ts) is ever
-- allowed to call this RPC — see the SECURITY INVOKER comment above for why
-- unauthenticated callers must never reach it directly.
REVOKE ALL ON FUNCTION public.rename_card_pack(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rename_card_pack(UUID, TEXT, TEXT) TO service_role;
