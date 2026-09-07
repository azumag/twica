-- Runs against the complete migrated CI schema, never production. Roll back
-- all fixture rows. SQL assertions exercise the real functions and constraints.
BEGIN;
INSERT INTO public.streamers(id,twitch_user_id,twitch_username,twitch_display_name,card_pack_names,pack_rarity_weights)
VALUES ('72000000-0000-0000-0000-000000000001','completion-fixture-streamer','completion_fixture','Completion fixture','["A"]','{"A":{"rare":100}}');
INSERT INTO public.users(id,twitch_user_id,twitch_username,twitch_display_name)
VALUES ('72000000-0000-0000-0000-000000000002','completion-fixture-viewer','completion_viewer','Viewer');
INSERT INTO public.cards(id,streamer_id,name,is_active,collection_name) VALUES
('72000000-0000-0000-0000-000000000003','72000000-0000-0000-0000-000000000001','Normal',true,null),
('72000000-0000-0000-0000-000000000004','72000000-0000-0000-0000-000000000001','Bonus',false,null);
INSERT INTO public.user_cards(user_id,card_id) VALUES
('72000000-0000-0000-0000-000000000002','72000000-0000-0000-0000-000000000003');
SET LOCAL ROLE service_role;
DO $$
DECLARE s uuid := '72000000-0000-0000-0000-000000000001';
  b uuid := '72000000-0000-0000-0000-000000000004'; r jsonb; n integer;
BEGIN
  r := public.set_pack_completion_reward(s,'__default__',b);
  IF r->>'ok' <> 'true' THEN RAISE EXCEPTION 'setting failed: %',r; END IF;
  r := public.grant_pack_completion_reward('completion-fixture-viewer',s,'__default__',b);
  IF r->>'granted' <> 'true' THEN RAISE EXCEPTION 'bonus was required for completion: %',r; END IF;
  r := public.grant_pack_completion_reward('completion-fixture-viewer',s,'__default__',b);
  IF r->>'already_granted' <> 'true' THEN RAISE EXCEPTION 'grant was not idempotent: %',r; END IF;
  SELECT count(*) INTO n FROM public.user_cards WHERE card_id=b;
  IF n <> 1 THEN RAISE EXCEPTION 'expected one bonus, got %',n; END IF;
  BEGIN
    UPDATE public.cards SET is_active=true WHERE id=b;
    RAISE EXCEPTION 'activation unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0720' THEN NULL;
  END;
  PERFORM public.set_pack_completion_reward(s,'A',b);
  r := public.grant_pack_completion_reward('completion-fixture-viewer',s,'A',b);
  IF r->>'reason' <> 'incomplete' THEN RAISE EXCEPTION 'empty pack completed'; END IF;
  r := public.grant_pack_completion_reward('nonexistent-viewer',s,'A',b);
  IF r->>'reason' <> 'user_not_found' THEN RAISE EXCEPTION 'missing user mishandled'; END IF;
  INSERT INTO public.pack_completion_rewards(streamer_id,collection_name,reward_card_id) VALUES(s,'C',b);
  INSERT INTO public.pack_completion_reward_grants(twitch_user_id,streamer_id,collection_name,reward_card_id)
    VALUES ('completion-fixture-viewer',s,'A',b),('completion-fixture-viewer',s,'C',b);
  PERFORM public.rename_card_pack(s,'A','C');
  IF NOT EXISTS(SELECT 1 FROM public.streamers WHERE id=s AND pack_rarity_weights='{"C":{"rare":100}}') THEN
    RAISE EXCEPTION 'rename lost rarity weights';
  END IF;
  IF EXISTS(SELECT 1 FROM public.pack_completion_rewards WHERE streamer_id=s AND collection_name='A') THEN
    RAISE EXCEPTION 'rename left live source setting behind';
  END IF;
END;
$$;
ROLLBACK;
