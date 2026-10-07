-- migration-transaction: required
-- migration-providers: planetscale
-- Refs #741; follow-up to PR #1764 review 5442386882.
--
-- Keep the already-merged migration immutable: environments that recorded its
-- version need a new version to receive the correction. CREATE OR REPLACE keeps
-- the existing function owner/permissions and callers; do not change grants.
-- RANK peers must be determined by value alone (equal values share rank, with
-- gaps). ROW_NUMBER still orders by streamer_id to give every row a stable,
-- unique position for neighbouring-page queries. All aggregation, cooldown,
-- backfill and atomic snapshot replacement behaviour stays the same.
-- https://www.postgresql.org/docs/17/functions-window.html
-- https://www.postgresql.org/docs/17/sql-createfunction.html

CREATE OR REPLACE FUNCTION public.refresh_streamer_ranking()
RETURNS TABLE(skipped boolean, reason text, snapshot_count integer)
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := now();
  v_today date := (v_now AT TIME ZONE 'Asia/Tokyo')::date;
  v_week_start date := (v_now AT TIME ZONE 'Asia/Tokyo')::date - 6;
  v_month_start date := (v_now AT TIME ZONE 'Asia/Tokyo')::date - 29;
  v_last_computed timestamptz;
  v_backfilled boolean;
  v_count integer;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('twica:stats:refresh')) THEN
    RETURN QUERY SELECT true, 'lock-contention'::text, 0;
    RETURN;
  END IF;

  SELECT MAX(s.computed_at) INTO v_last_computed
  FROM public.streamer_ranking_snapshots s;
  IF v_last_computed IS NOT NULL AND v_last_computed > v_now - interval '10 minutes' THEN
    RETURN QUERY SELECT true, 'cooldown'::text, 0;
    RETURN;
  END IF;

  PERFORM public.refresh_streamer_daily_stats(
    v_now - interval '48 hours',
    v_now
  );

  SELECT EXISTS (
    SELECT 1 FROM public.stats_meta m
    WHERE m.key = 'daily_stats_backfilled_at'
  ) INTO v_backfilled;
  IF NOT v_backfilled THEN
    RETURN QUERY SELECT true, 'backfill-pending'::text, 0;
    RETURN;
  END IF;

  DELETE FROM public.streamer_ranking_snapshots;

  WITH population AS (
    SELECT DISTINCT d.streamer_id
    FROM public.streamer_daily_stats d
    WHERE d.stat_date >= v_month_start
  ),
  draws_total AS (
    SELECT d.streamer_id, SUM(d.draw_count)::bigint AS value
    FROM public.streamer_daily_stats d
    JOIN population p ON p.streamer_id = d.streamer_id
    GROUP BY d.streamer_id
  ),
  draws_weekly AS (
    SELECT d.streamer_id, SUM(d.draw_count)::bigint AS value
    FROM public.streamer_daily_stats d
    JOIN population p ON p.streamer_id = d.streamer_id
    WHERE d.stat_date >= v_week_start
    GROUP BY d.streamer_id
    HAVING SUM(d.draw_count) > 0
  ),
  draws_daily AS (
    SELECT d.streamer_id, SUM(d.draw_count)::bigint AS value
    FROM public.streamer_daily_stats d
    JOIN population p ON p.streamer_id = d.streamer_id
    WHERE d.stat_date = v_today
    GROUP BY d.streamer_id
    HAVING SUM(d.draw_count) > 0
  ),
  card_current AS (
    SELECT c.streamer_id, COUNT(*)::bigint AS value
    FROM public.cards c
    JOIN population p ON p.streamer_id = c.streamer_id
    GROUP BY c.streamer_id
  ),
  ranked AS (
    SELECT 'draws'::text AS metric, 'total'::text AS period, streamer_id, value FROM draws_total
    UNION ALL
    SELECT 'draws', 'weekly', streamer_id, value FROM draws_weekly
    UNION ALL
    SELECT 'draws', 'daily', streamer_id, value FROM draws_daily
    UNION ALL
    SELECT 'card_count', 'current', streamer_id, value FROM card_current
  ),
  positioned AS (
    SELECT
      r.metric,
      r.period,
      r.streamer_id,
      RANK() OVER (PARTITION BY r.metric, r.period ORDER BY r.value DESC)::integer AS rank,
      ROW_NUMBER() OVER (PARTITION BY r.metric, r.period ORDER BY r.value DESC, r.streamer_id)::integer AS position,
      r.value,
      COUNT(*) OVER (PARTITION BY r.metric, r.period)::integer AS participant_count
    FROM ranked r
  )
  INSERT INTO public.streamer_ranking_snapshots
    (metric, period, streamer_id, rank, position, value, participant_count, computed_at)
  SELECT metric, period, streamer_id, rank, position, value, participant_count, v_now
  FROM positioned;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN QUERY SELECT false, 'refreshed'::text, v_count;
END;
$$;
