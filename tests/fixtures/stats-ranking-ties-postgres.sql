\set ON_ERROR_STOP on

-- Apply all PlanetScale migrations first, then run on disposable PostgreSQL 17:
-- psql -X -v ON_ERROR_STOP=1 -f tests/fixtures/stats-ranking-ties-postgres.sql
-- The real refresh/backfill functions run as service_role. Everything, including
-- clearing other fixtures' aggregation inputs, rolls back so the shared CI
-- database and subsequent fixtures retain their original data and permissions.
BEGIN;

DELETE FROM public.gacha_history;
DELETE FROM public.streamer_daily_stats;
DELETE FROM public.streamer_ranking_snapshots;
DELETE FROM public.stats_meta WHERE key = 'daily_stats_backfilled_at';

-- Insert in reverse UUID order: equal values must get stable positions from
-- streamer_id rather than insertion order, while RANK must ignore that UUID.
INSERT INTO public.streamers (id, twitch_user_id, twitch_username, twitch_display_name)
VALUES
  ('74170000-0000-4000-8000-000000000003', 'stats-ties-3', 'stats-ties-3', 'Stats Ties Third'),
  ('74170000-0000-4000-8000-000000000002', 'stats-ties-2', 'stats-ties-2', 'Stats Ties Second'),
  ('74170000-0000-4000-8000-000000000001', 'stats-ties-1', 'stats-ties-1', 'Stats Ties First');

INSERT INTO public.cards (id, streamer_id, name)
VALUES
  ('74170000-0000-4000-8000-000000000031', '74170000-0000-4000-8000-000000000003', 'Stats Ties Third Card'),
  ('74170000-0000-4000-8000-000000000022', '74170000-0000-4000-8000-000000000002', 'Stats Ties Second Card B'),
  ('74170000-0000-4000-8000-000000000021', '74170000-0000-4000-8000-000000000002', 'Stats Ties Second Card A'),
  ('74170000-0000-4000-8000-000000000012', '74170000-0000-4000-8000-000000000001', 'Stats Ties First Card B'),
  ('74170000-0000-4000-8000-000000000011', '74170000-0000-4000-8000-000000000001', 'Stats Ties First Card A');

-- Today, three days ago, and ten days ago give distinct daily/weekly/total
-- values [2,2,1], [4,4,2], [6,6,3]. All dates use the application's JST boundary.
INSERT INTO public.gacha_history
  (streamer_id, card_id, user_twitch_id, user_twitch_username, event_id, redeemed_at, reward_cost)
SELECT seed.streamer_id, seed.card_id, 'stats-ties-viewer', 'StatsTiesViewer',
  format('stats-ties:%s:%s:%s', seed.streamer_id, days.ago, draws.n),
  (((now() AT TIME ZONE 'Asia/Tokyo')::date - days.ago)::timestamp AT TIME ZONE 'Asia/Tokyo'),
  100
FROM (VALUES
  ('74170000-0000-4000-8000-000000000003'::uuid, '74170000-0000-4000-8000-000000000031'::uuid, 1),
  ('74170000-0000-4000-8000-000000000002'::uuid, '74170000-0000-4000-8000-000000000021'::uuid, 2),
  ('74170000-0000-4000-8000-000000000001'::uuid, '74170000-0000-4000-8000-000000000011'::uuid, 2)
) AS seed(streamer_id, card_id, draw_count)
CROSS JOIN (VALUES (0), (3), (10)) AS days(ago)
CROSS JOIN LATERAL generate_series(1, seed.draw_count) AS draws(n);

-- Counting manual draws would put the third streamer ahead, breaking the
-- value/rank assertions in every draws period. They must remain excluded by
-- both the incremental refresh and the historical backfill functions.
INSERT INTO public.gacha_history
  (streamer_id, card_id, user_twitch_id, user_twitch_username, event_id, redeemed_at, reward_cost)
SELECT '74170000-0000-4000-8000-000000000003'::uuid, '74170000-0000-4000-8000-000000000031'::uuid,
  'stats-ties-viewer', 'StatsTiesViewer', format('manual:stats-ties:%s:%s', days.ago, draws.n),
  (((now() AT TIME ZONE 'Asia/Tokyo')::date - days.ago)::timestamp AT TIME ZONE 'Asia/Tokyo'),
  0
FROM (VALUES (0), (3), (10)) AS days(ago)
CROSS JOIN generate_series(1, 3) AS draws(n);

-- An old snapshot must survive the backfill gate and later be replaced as part
-- of the full four-metric refresh, rather than being deleted on a skipped run.
INSERT INTO public.streamer_ranking_snapshots
  (metric, period, streamer_id, rank, position, value, participant_count, computed_at)
VALUES ('draws', 'total', '74170000-0000-4000-8000-000000000003', 99, 99, 99, 99, now() - interval '1 hour');

DO $$
DECLARE
  v_role text;
  v_function text;
  v_table text;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    'public.refresh_streamer_ranking()',
    'public.refresh_streamer_daily_stats(timestamptz,timestamptz)',
    'public.backfill_streamer_daily_stats()'
  ] LOOP
    IF NOT has_function_privilege('service_role', v_function, 'EXECUTE') THEN
      RAISE EXCEPTION 'runtime role lost execute privilege on %', v_function;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_function_privilege(v_role, v_function, 'EXECUTE') THEN
        RAISE EXCEPTION 'ranking function % leaked to %', v_function, v_role;
      END IF;
    END LOOP;
  END LOOP;
  FOREACH v_table IN ARRAY ARRAY[
    'public.streamer_daily_stats', 'public.streamer_ranking_snapshots', 'public.stats_meta'
  ] LOOP
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_table_privilege(v_role, v_table, 'SELECT,INSERT,UPDATE,DELETE') THEN
        RAISE EXCEPTION 'ranking table % leaked to %', v_table, v_role;
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

SET LOCAL ROLE service_role;

DO $$
DECLARE
  v_result record;
  v_expected record;
  v_ranks integer[];
  v_positions integer[];
  v_streamers uuid[];
  v_values bigint[];
  v_participants integer[];
  v_before jsonb;
  v_after jsonb;
BEGIN
  SELECT jsonb_agg(to_jsonb(s) ORDER BY s.metric, s.period, s.position)
    INTO v_before FROM public.streamer_ranking_snapshots s;
  SELECT * INTO v_result FROM public.refresh_streamer_ranking();
  IF v_result.skipped IS DISTINCT FROM true OR v_result.reason IS DISTINCT FROM 'backfill-pending'
     OR v_result.snapshot_count IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'backfill gate changed: %', row_to_json(v_result);
  END IF;
  SELECT jsonb_agg(to_jsonb(s) ORDER BY s.metric, s.period, s.position)
    INTO v_after FROM public.streamer_ranking_snapshots s;
  IF v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'backfill-pending run changed the old snapshot';
  END IF;

  SELECT * INTO v_result FROM public.backfill_streamer_daily_stats();
  IF v_result.rebuilt_rows IS DISTINCT FROM 9 OR v_result.backfilled_at IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.stats_meta WHERE key = 'daily_stats_backfilled_at') THEN
    RAISE EXCEPTION 'backfill failed to build all JST dates and record its marker: %', row_to_json(v_result);
  END IF;
  IF EXISTS (SELECT 1 FROM public.streamer_daily_stats
    WHERE draw_count <> CASE WHEN streamer_id = '74170000-0000-4000-8000-000000000003' THEN 1 ELSE 2 END) THEN
    RAISE EXCEPTION 'manual draws affected daily stats after backfill';
  END IF;

  SELECT * INTO v_result FROM public.refresh_streamer_ranking();
  IF v_result.skipped IS DISTINCT FROM false OR v_result.reason IS DISTINCT FROM 'refreshed'
     OR v_result.snapshot_count IS DISTINCT FROM 12 THEN
    RAISE EXCEPTION 'expected all four ranking snapshots: %', row_to_json(v_result);
  END IF;
  FOR v_expected IN SELECT * FROM (VALUES
    ('draws', 'daily', ARRAY[2,2,1]::bigint[]),
    ('draws', 'weekly', ARRAY[4,4,2]::bigint[]),
    ('draws', 'total', ARRAY[6,6,3]::bigint[]),
    ('card_count', 'current', ARRAY[2,2,1]::bigint[])
  ) AS expected(metric, period, expected_values) LOOP
    SELECT array_agg(s.rank ORDER BY s.position), array_agg(s.position ORDER BY s.position),
      array_agg(s.streamer_id ORDER BY s.position), array_agg(s.value ORDER BY s.position),
      array_agg(s.participant_count ORDER BY s.position)
    INTO v_ranks, v_positions, v_streamers, v_values, v_participants
    FROM public.streamer_ranking_snapshots s
    WHERE s.metric = v_expected.metric AND s.period = v_expected.period;
    IF v_ranks IS DISTINCT FROM ARRAY[1,1,3]
       OR v_positions IS DISTINCT FROM ARRAY[1,2,3]
       OR v_streamers IS DISTINCT FROM ARRAY[
         '74170000-0000-4000-8000-000000000001',
         '74170000-0000-4000-8000-000000000002',
         '74170000-0000-4000-8000-000000000003'
       ]::uuid[]
       OR v_values IS DISTINCT FROM v_expected.expected_values
       OR v_participants IS DISTINCT FROM ARRAY[3,3,3] THEN
      RAISE EXCEPTION 'ranking peers/positions changed for %/%: ranks %, positions %, streamers %, values %, participants %',
        v_expected.metric, v_expected.period, v_ranks, v_positions, v_streamers, v_values, v_participants;
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT computed_at) FROM public.streamer_ranking_snapshots) <> 1 THEN
    RAISE EXCEPTION 'ranking snapshot timestamps are not atomic';
  END IF;

  SELECT jsonb_agg(to_jsonb(s) ORDER BY s.metric, s.period, s.position)
    INTO v_before FROM public.streamer_ranking_snapshots s;
  SELECT * INTO v_result FROM public.refresh_streamer_ranking();
  IF v_result.skipped IS DISTINCT FROM true OR v_result.reason IS DISTINCT FROM 'cooldown'
     OR v_result.snapshot_count IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'cooldown gate changed: %', row_to_json(v_result);
  END IF;
  SELECT jsonb_agg(to_jsonb(s) ORDER BY s.metric, s.period, s.position)
    INTO v_after FROM public.streamer_ranking_snapshots s;
  IF v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'cooldown run changed the existing ranking snapshot';
  END IF;
END;
$$;

RESET ROLE;
ROLLBACK;
