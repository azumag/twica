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

DO $$
DECLARE
  users_page JSONB;
  users_filtered JSONB;
  streamers_page JSONB;
  options_page JSONB;
BEGIN
  users_page := get_analysis_users_page(1, 2, NULL, 'card_count_desc', FALSE);
  IF jsonb_array_length(users_page -> 'rows') <> 2
    OR (users_page ->> 'count')::INTEGER <> 3
    OR (users_page -> 'summary' ->> 'totalCards')::INTEGER <> 3
    OR users_page -> 'rows' -> 0 ->> 'id' <> '00000000-0000-0000-0000-000000000101'
  THEN
    RAISE EXCEPTION 'users page contract mismatch: %', users_page;
  END IF;

  users_filtered := get_analysis_users_page(1, 100, '%fixture-user-2%', 'name_asc', TRUE);
  IF jsonb_array_length(users_filtered -> 'rows') <> 1
    OR (users_filtered ->> 'count')::INTEGER <> 1
    OR users_filtered -> 'rows' -> 0 ->> 'id' <> '00000000-0000-0000-0000-000000000102'
  THEN
    RAISE EXCEPTION 'users filter contract mismatch: %', users_filtered;
  END IF;

  streamers_page := get_analysis_streamers_page(1, 1, NULL, 'card_count_desc', FALSE, FALSE, FALSE, FALSE, FALSE);
  IF jsonb_array_length(streamers_page -> 'rows') <> 1
    OR (streamers_page ->> 'count')::INTEGER <> 2
    OR (streamers_page -> 'summary' ->> 'totalCards')::INTEGER <> 3
    OR streamers_page -> 'rows' -> 0 ->> 'id' <> '00000000-0000-0000-0000-000000000201'
  THEN
    RAISE EXCEPTION 'streamers page contract mismatch: %', streamers_page;
  END IF;

  options_page := get_analysis_streamer_options_page(1, 1, '%fixture-streamer%');
  IF jsonb_array_length(options_page -> 'rows') <> 1
    OR (options_page ->> 'count')::INTEGER <> 2
  THEN
    RAISE EXCEPTION 'streamer options contract mismatch: %', options_page;
  END IF;

  IF NOT has_function_privilege(
    'service_role',
    'get_analysis_users_page(integer,integer,text,text,boolean)',
    'EXECUTE'
  ) OR has_function_privilege(
    'anon',
    'get_analysis_users_page(integer,integer,text,text,boolean)',
    'EXECUTE'
  )
  THEN
    RAISE EXCEPTION 'analysis page RPC privilege contract mismatch';
  END IF;
END
$$;

ROLLBACK;
