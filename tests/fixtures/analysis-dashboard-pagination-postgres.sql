-- analysis dashboard のページRPCを実PostgreSQL上で検証するfixture。
--
-- SQL文字列の存在確認だけでは、関数の構文、JSONの形、件数とページ行の整合性、
-- フィルタ境界を保証できない。CIのPlanetScale互換PostgreSQL 17へ最小データを
-- 同一トランザクション内で投入し、実際に各RPCを呼び出してからROLLBACKする。
-- そのためCI用DBにテストデータを残さず、空データ・100件超の大規模fixtureを
-- 作らなくても「ページを返す契約が実行可能であること」を毎回検証できる。

BEGIN;

INSERT INTO users (
  id,
  twitch_user_id,
  twitch_username,
  twitch_display_name,
  created_at,
  updated_at
)
VALUES
  (
    '00000000-0000-0000-0000-000000000101',
    'fixture-user-1',
    'fixture-user-1',
    'Fixture User 1',
    '2026-01-03T00:00:00Z',
    '2026-01-03T00:00:00Z'
  ),
  (
    '00000000-0000-0000-0000-000000000102',
    'fixture-user-2',
    'fixture-user-2',
    'Fixture User 2',
    '2026-01-02T00:00:00Z',
    '2026-01-02T00:00:00Z'
  ),
  (
    '00000000-0000-0000-0000-000000000103',
    'fixture-user-3',
    'fixture-user-3',
    'Fixture User 3',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z'
  );

INSERT INTO streamers (
  id,
  twitch_user_id,
  twitch_username,
  twitch_display_name,
  created_at,
  updated_at
)
VALUES
  (
    '00000000-0000-0000-0000-000000000201',
    'fixture-streamer-1',
    'fixture-streamer-1',
    'Fixture Streamer 1',
    '2026-01-03T00:00:00Z',
    '2026-01-03T00:00:00Z'
  ),
  (
    '00000000-0000-0000-0000-000000000202',
    'fixture-streamer-2',
    'fixture-streamer-2',
    'Fixture Streamer 2',
    '2026-01-02T00:00:00Z',
    '2026-01-02T00:00:00Z'
  );

INSERT INTO cards (id, streamer_id, name, rarity)
VALUES
  (
    '00000000-0000-0000-0000-000000000301',
    '00000000-0000-0000-0000-000000000201',
    'Fixture Card 1',
    'common'
  ),
  (
    '00000000-0000-0000-0000-000000000302',
    '00000000-0000-0000-0000-000000000201',
    'Fixture Card 2',
    'rare'
  ),
  (
    '00000000-0000-0000-0000-000000000303',
    '00000000-0000-0000-0000-000000000202',
    'Fixture Card 3',
    'epic'
  );

INSERT INTO user_cards (id, user_id, card_id, obtained_at)
VALUES
  (
    '00000000-0000-0000-0000-000000000401',
    '00000000-0000-0000-0000-000000000101',
    '00000000-0000-0000-0000-000000000301',
    '2026-01-03T00:00:00Z'
  ),
  (
    '00000000-0000-0000-0000-000000000402',
    '00000000-0000-0000-0000-000000000101',
    '00000000-0000-0000-0000-000000000302',
    '2026-01-03T00:00:00Z'
  ),
  (
    '00000000-0000-0000-0000-000000000403',
    '00000000-0000-0000-0000-000000000102',
    '00000000-0000-0000-0000-000000000303',
    '2026-01-02T00:00:00Z'
  );

INSERT INTO gacha_history (
  id,
  user_twitch_id,
  user_twitch_username,
  card_id,
  streamer_id,
  redeemed_at,
  event_id
)
VALUES
  (
    '00000000-0000-0000-0000-000000000501',
    'fixture-user-1',
    'fixture-user-1',
    '00000000-0000-0000-0000-000000000301',
    '00000000-0000-0000-0000-000000000201',
    '2026-01-03T00:00:00Z',
    'fixture-gacha-1'
  ),
  (
    '00000000-0000-0000-0000-000000000502',
    'fixture-user-2',
    'fixture-user-2',
    '00000000-0000-0000-0000-000000000302',
    '00000000-0000-0000-0000-000000000201',
    '2026-01-02T00:00:00Z',
    'fixture-gacha-2'
  ),
  (
    '00000000-0000-0000-0000-000000000503',
    'fixture-user-3',
    'fixture-user-3',
    '00000000-0000-0000-0000-000000000303',
    '00000000-0000-0000-0000-000000000202',
    '2026-01-01T00:00:00Z',
    'fixture-gacha-3'
  );

-- 一覧の候補CTEへ移した検索・チャット系フィルターも、ページRPCから
-- 直接評価されることを確認する。fixture-streamer-1は同じTwitch IDの
-- usersレコードを持たないため、chat_send_available=falseとなり、
-- filter_missing_scopeの対象にもなる。
UPDATE streamers
SET
  chat_announcement_enabled = TRUE,
  chat_announcement_template = 'Fixture {user}'
WHERE id = '00000000-0000-0000-0000-000000000201';

DO $$
DECLARE
  users_page JSONB;
  users_summary JSONB;
  users_filtered JSONB;
  streamers_page JSONB;
  streamers_summary JSONB;
  streamers_filtered JSONB;
  options_page JSONB;
  gacha_summary JSONB;
BEGIN
  users_page := get_analysis_users_page(1, 2, NULL, 'card_count_desc', FALSE);
  users_summary := get_analysis_users_summary();
  IF jsonb_array_length(users_page -> 'rows') <> 2
    OR (users_page ->> 'count')::INTEGER <> 3
    OR users_page -> 'rows' -> 0 ->> 'id' <> '00000000-0000-0000-0000-000000000101'
    OR (users_summary ->> 'totalUsers')::INTEGER <> 3
    OR (users_summary ->> 'totalCards')::INTEGER <> 3
    OR (users_summary ->> 'usersWithCards')::INTEGER <> 2
  THEN
    RAISE EXCEPTION 'users page/summary contract mismatch: % / %', users_page, users_summary;
  END IF;

  users_filtered := get_analysis_users_page(1, 100, '%fixture-user-2%', 'name_asc', TRUE);
  IF jsonb_array_length(users_filtered -> 'rows') <> 1
    OR (users_filtered ->> 'count')::INTEGER <> 1
    OR users_filtered -> 'rows' -> 0 ->> 'id' <> '00000000-0000-0000-0000-000000000102'
  THEN
    RAISE EXCEPTION 'users filter contract mismatch: %', users_filtered;
  END IF;

  streamers_page := get_analysis_streamers_page(1, 1, NULL, 'card_count_desc', FALSE, FALSE, FALSE, FALSE, FALSE);
  streamers_summary := get_analysis_streamers_summary();
  IF jsonb_array_length(streamers_page -> 'rows') <> 1
    OR (streamers_page ->> 'count')::INTEGER <> 2
    OR streamers_page -> 'rows' -> 0 ->> 'id' <> '00000000-0000-0000-0000-000000000201'
    OR (streamers_summary ->> 'totalStreamers')::INTEGER <> 2
    OR (streamers_summary ->> 'totalCards')::INTEGER <> 3
    OR (streamers_summary ->> 'chatEnabledStreamers')::INTEGER <> 1
  THEN
    RAISE EXCEPTION 'streamers page/summary contract mismatch: % / %', streamers_page, streamers_summary;
  END IF;

  streamers_filtered := get_analysis_streamers_page(
    1,
    100,
    '%fixture-streamer%',
    'name_asc',
    FALSE,
    TRUE,
    TRUE,
    TRUE,
    FALSE
  );
  IF jsonb_array_length(streamers_filtered -> 'rows') <> 1
    OR (streamers_filtered ->> 'count')::INTEGER <> 1
    OR streamers_filtered -> 'rows' -> 0 ->> 'id' <> '00000000-0000-0000-0000-000000000201'
  THEN
    RAISE EXCEPTION 'streamers filter contract mismatch: %', streamers_filtered;
  END IF;

  options_page := get_analysis_streamer_options_page(1, 1, '%fixture-streamer%');
  IF jsonb_array_length(options_page -> 'rows') <> 1
    OR (options_page ->> 'count')::INTEGER <> 2
  THEN
    RAISE EXCEPTION 'streamer options contract mismatch: %', options_page;
  END IF;

  gacha_summary := get_analysis_gacha_summary(
    '2026-01-02T00:00:00Z',
    '00000000-0000-0000-0000-000000000201'
  );
  IF (gacha_summary ->> 'totalGacha')::INTEGER <> 2
    OR (gacha_summary ->> 'uniqueUsers')::INTEGER <> 2
    OR jsonb_array_length(gacha_summary -> 'dailyGachaData') <> 2
  THEN
    RAISE EXCEPTION 'gacha summary contract mismatch: %', gacha_summary;
  END IF;

  IF NOT has_function_privilege(
    'service_role',
    'get_analysis_users_page(integer,integer,text,text,boolean)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'get_analysis_users_summary()',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'get_analysis_streamers_summary()',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'get_analysis_streamers_page(integer,integer,text,text,boolean,boolean,boolean,boolean,boolean)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'get_analysis_streamer_leaderboard()',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'get_analysis_users()',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'get_analysis_streamers()',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'get_analysis_gacha_summary(timestamptz,uuid)',
    'EXECUTE'
  ) OR has_function_privilege(
    'anon',
    'get_analysis_users_page(integer,integer,text,text,boolean)',
    'EXECUTE'
  ) OR has_function_privilege(
    'anon',
    'get_analysis_users_summary()',
    'EXECUTE'
  ) OR has_function_privilege(
    'anon',
    'get_analysis_streamers_page(integer,integer,text,text,boolean,boolean,boolean,boolean,boolean)',
    'EXECUTE'
  ) OR has_function_privilege(
    'anon',
    'get_analysis_streamers_summary()',
    'EXECUTE'
  ) OR has_function_privilege(
    'anon',
    'get_analysis_streamer_leaderboard()',
    'EXECUTE'
  ) OR has_function_privilege(
    'anon',
    'get_analysis_users()',
    'EXECUTE'
  ) OR has_function_privilege(
    'anon',
    'get_analysis_streamers()',
    'EXECUTE'
  ) OR has_function_privilege(
    'anon',
    'get_analysis_gacha_summary(timestamptz,uuid)',
    'EXECUTE'
  )
  THEN
    RAISE EXCEPTION 'analysis page RPC privilege contract mismatch';
  END IF;
END
$$;

-- 小規模fixtureだけでは、統計情報が少なすぎてPostgreSQLが常にSeq Scanを
-- 選ぶため、検索性能の回帰を検出できない。実データを永続化しない同一transaction
-- 内で500,000行ずつ投入し、ANALYZE後の実行計画を確認する。ILIKE検索は1件程度、
-- 7日検索は全体の約2%に絞り、plannerがGIN/期間索引を選ぶ十分な選択性を作る。
INSERT INTO users (
  id,
  twitch_user_id,
  twitch_username,
  twitch_display_name,
  created_at,
  updated_at
)
SELECT
  md5('analysis-perf-user-' || i)::UUID,
  'analysis-perf-user-' || i,
  'analysis-perf-user-' || i,
  'Analysis Perf User ' || i,
  TIMESTAMPTZ '2025-01-01T00:00:00Z' + i * INTERVAL '1 minute',
  TIMESTAMPTZ '2025-01-01T00:00:00Z' + i * INTERVAL '1 minute'
FROM generate_series(1, 500000) AS series(i);

INSERT INTO streamers (
  id,
  twitch_user_id,
  twitch_username,
  twitch_display_name,
  created_at,
  updated_at
)
SELECT
  md5('analysis-perf-streamer-' || i)::UUID,
  'analysis-perf-streamer-' || i,
  'analysis-perf-streamer-' || i,
  'Analysis Perf Streamer ' || i,
  TIMESTAMPTZ '2025-01-01T00:00:00Z' + i * INTERVAL '1 minute',
  TIMESTAMPTZ '2025-01-01T00:00:00Z' + i * INTERVAL '1 minute'
FROM generate_series(1, 500000) AS series(i);

INSERT INTO gacha_history (
  id,
  user_twitch_id,
  user_twitch_username,
  card_id,
  streamer_id,
  redeemed_at,
  event_id
)
SELECT
  md5('analysis-perf-gacha-' || i)::UUID,
  'analysis-perf-user-' || i,
  'analysis-perf-user-' || i,
  '00000000-0000-0000-0000-000000000301',
  '00000000-0000-0000-0000-000000000201',
  TIMESTAMPTZ '2026-01-01T00:00:00Z' + ((i - 1) % 365) * INTERVAL '1 day',
  'analysis-perf-gacha-' || i
FROM generate_series(1, 500000) AS series(i);

ANALYZE users;
ANALYZE streamers;
ANALYZE gacha_history;

DO $$
DECLARE
  users_plan JSONB;
  streamers_plan JSONB;
  gacha_user_count_plan JSONB;
  gacha_user_page_plan JSONB;
  gacha_plan JSONB;
BEGIN
  EXECUTE $plan$
    EXPLAIN (FORMAT JSON)
    SELECT u.id
    FROM users u
    WHERE u.twitch_username ILIKE '%analysis-perf-user-19999%' ESCAPE E'\\'
       OR u.twitch_display_name ILIKE '%analysis-perf-user-19999%' ESCAPE E'\\'
    LIMIT 100
  $plan$ INTO users_plan;

  IF users_plan::TEXT NOT LIKE '%idx_users_analysis_search_trgm%' THEN
    RAISE EXCEPTION 'users search plan did not use the trigram index: %', users_plan;
  END IF;

  EXECUTE $plan$
    EXPLAIN (FORMAT JSON)
    SELECT s.id
    FROM streamers s
    WHERE s.twitch_username ILIKE '%analysis-perf-streamer-19999%' ESCAPE E'\\'
       OR s.twitch_display_name ILIKE '%analysis-perf-streamer-19999%' ESCAPE E'\\'
       OR s.twitch_user_id ILIKE '%analysis-perf-streamer-19999%' ESCAPE E'\\'
    LIMIT 100
  $plan$ INTO streamers_plan;

  IF streamers_plan::TEXT NOT LIKE '%idx_streamers_analysis_search_trgm%' THEN
    RAISE EXCEPTION 'streamer search plan did not use the trigram index: %', streamers_plan;
  END IF;

  EXECUTE $plan$
    EXPLAIN (FORMAT JSON)
    SELECT count(*)
    FROM gacha_history gh
    WHERE gh.user_twitch_username ILIKE '%analysis-perf-user-19999%' ESCAPE E'\\'
  $plan$ INTO gacha_user_count_plan;

  IF gacha_user_count_plan::TEXT NOT LIKE '%idx_gacha_history_username_analysis_search_trgm%' THEN
    RAISE EXCEPTION 'gacha username count plan did not use the trigram index: %', gacha_user_count_plan;
  END IF;

  EXECUTE $plan$
    EXPLAIN (FORMAT JSON)
    SELECT gh.id
    FROM gacha_history gh
    WHERE gh.user_twitch_username ILIKE '%analysis-perf-user-19999%' ESCAPE E'\\'
    ORDER BY gh.redeemed_at DESC, gh.id DESC
    LIMIT 100
  $plan$ INTO gacha_user_page_plan;

  IF gacha_user_page_plan::TEXT NOT LIKE '%idx_gacha_history_username_analysis_search_trgm%' THEN
    RAISE EXCEPTION 'gacha username page plan did not use the trigram index: %', gacha_user_page_plan;
  END IF;

  EXECUTE $plan$
    EXPLAIN (FORMAT JSON)
    SELECT gh.id
    FROM gacha_history gh
    WHERE gh.redeemed_at >= '2026-12-25T00:00:00Z'::TIMESTAMPTZ
    ORDER BY gh.redeemed_at DESC
    LIMIT 100
  $plan$ INTO gacha_plan;

  IF gacha_plan::TEXT NOT LIKE '%idx_gacha_history_redeemed_at_analysis%' THEN
    RAISE EXCEPTION 'gacha 7-day plan did not use the redeemed_at index: %', gacha_plan;
  END IF;
END
$$;

ROLLBACK;
