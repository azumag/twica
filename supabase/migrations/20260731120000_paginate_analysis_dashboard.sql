-- analysis dashboard の初回取得を、全件JSON配列からDB側ページングへ移行する。
--
-- 以前の get_analysis_users()/get_analysis_streamers() は、一覧用の全行を
-- jsonb_agg() してからNode.jsとブラウザへ転送していた。画面側にページャーが
-- あっても、ページャーは既に全件取得した配列をsliceしているだけだったため、
-- データ量に比例してDBメモリ、Node.jsメモリ、転送量、ブラウザの保持量が増えていた。
--
-- 新しい関数は検索・フィルタ・ソート・LIMIT/OFFSETをDB側で適用し、JSON化するのは
-- 現在ページの行だけに限定する。summaryは配列ではなくCOUNT/SUMのスカラーで返し、
-- UIの全体統計を維持しながら大量レコードの転送を避ける。

-- 一覧・検索用の索引は、このトランザクションmigrationへ同居させない。
-- PlanetScaleの実DBでは対象テーブルに書き込みが続くため、索引作成を
-- CREATE INDEX CONCURRENTLY で別migrationとして適用し、ガチャ引き換えや
-- ユーザー登録の書き込みを通常のCREATE INDEXで長時間待たせないようにする。
-- 索引本体は db/planetscale/migrations/20260801090001〜20260801090005 に分離している。

-- Overviewの30日推移は日ごとのLATERAL COUNTを30回実行していたため、対象期間を
-- 先に一度だけGROUP BYしてから日付系列へLEFT JOINする。返却件数は従来どおり
-- 30日分 + 最新10件であり、契約を変えずにDBスキャン回数を減らす。
CREATE OR REPLACE FUNCTION get_analysis_overview()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
WITH bounds AS (
  SELECT
    date_trunc('day', now()) AS today_start,
    now() - interval '7 days' AS week_start,
    date_trunc('month', now()) AS month_start
),
day_series AS (
  SELECT generate_series(
    date_trunc('day', now()) - interval '29 days',
    date_trunc('day', now()),
    interval '1 day'
  ) AS day_start
),
user_growth_counts AS (
  SELECT date_trunc('day', u.created_at) AS day_start, COUNT(*)::INTEGER AS count
  FROM users u
  WHERE u.created_at >= date_trunc('day', now()) - interval '29 days'
  GROUP BY date_trunc('day', u.created_at)
),
gacha_growth_counts AS (
  SELECT date_trunc('day', gh.redeemed_at) AS day_start, COUNT(*)::INTEGER AS count
  FROM gacha_history gh
  WHERE gh.redeemed_at >= date_trunc('day', now()) - interval '29 days'
  GROUP BY date_trunc('day', gh.redeemed_at)
),
user_growth AS (
  SELECT jsonb_agg(
    jsonb_build_object(
      'date', to_char(ds.day_start, 'YYYY-MM-DD'),
      'count', COALESCE(ugc.count, 0)
    )
    ORDER BY ds.day_start
  ) AS rows
  FROM day_series ds
  LEFT JOIN user_growth_counts ugc ON ugc.day_start = ds.day_start
),
gacha_growth AS (
  SELECT jsonb_agg(
    jsonb_build_object(
      'date', to_char(ds.day_start, 'YYYY-MM-DD'),
      'count', COALESCE(ggc.count, 0)
    )
    ORDER BY ds.day_start
  ) AS rows
  FROM day_series ds
  LEFT JOIN gacha_growth_counts ggc ON ggc.day_start = ds.day_start
),
recent_gacha AS (
  SELECT COALESCE(jsonb_agg(row_json ORDER BY redeemed_at DESC), '[]'::jsonb) AS rows
  FROM (
    SELECT
      gh.redeemed_at,
      to_jsonb(gh.*)
        || jsonb_build_object(
          'cards', to_jsonb(c.*),
          'streamers', to_jsonb(s.*)
        ) AS row_json
    FROM gacha_history gh
    LEFT JOIN cards c ON c.id = gh.card_id
    LEFT JOIN streamers s ON s.id = gh.streamer_id
    ORDER BY gh.redeemed_at DESC
    LIMIT 10
  ) recent
)
SELECT jsonb_build_object(
  'stats', jsonb_build_object(
    'totalUsers', (SELECT COUNT(*)::INTEGER FROM users),
    'totalStreamers', (SELECT COUNT(*)::INTEGER FROM streamers),
    'totalCards', (SELECT COUNT(*)::INTEGER FROM cards),
    'todayGacha', (
      SELECT COUNT(*)::INTEGER FROM gacha_history gh, bounds b
      WHERE gh.redeemed_at >= b.today_start
    ),
    'weekGacha', (
      SELECT COUNT(*)::INTEGER FROM gacha_history gh, bounds b
      WHERE gh.redeemed_at >= b.week_start
    ),
    'monthGacha', (
      SELECT COUNT(*)::INTEGER FROM gacha_history gh, bounds b
      WHERE gh.redeemed_at >= b.month_start
    )
  ),
  'recentGacha', (SELECT rows FROM recent_gacha),
  'userGrowth', (SELECT rows FROM user_growth),
  'gachaGrowth', (SELECT rows FROM gacha_growth)
);
$$;

-- ガチャ集計の初期表示は7日間だが、p_from_date/p_streamer_idのNULL許容を
-- 1つのOR条件へまとめると、期間指定時にもredeemed_at索引や
-- (streamer_id, redeemed_at, ...)索引を使えない実行計画になり得る。
-- 条件の4通りをPL/pgSQL側で分岐し、動的SQLへ入れるのは固定文字列の
-- predicateだけにする。日付とUUIDは必ずUSINGでバインドし、検索値をSQLへ
-- 連結しない。全期間を明示した場合だけTRUE分岐になり、全走査を許容する。
CREATE OR REPLACE FUNCTION get_analysis_gacha_summary(
  p_from_date TIMESTAMPTZ DEFAULT NULL,
  p_streamer_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_filter TEXT;
  v_result JSONB;
BEGIN
  IF p_from_date IS NULL AND p_streamer_id IS NULL THEN
    v_filter := 'TRUE';
  ELSIF p_from_date IS NULL THEN
    v_filter := 'gh.streamer_id = $2';
  ELSIF p_streamer_id IS NULL THEN
    v_filter := 'gh.redeemed_at >= $1';
  ELSE
    v_filter := 'gh.streamer_id = $2 AND gh.redeemed_at >= $1';
  END IF;

  EXECUTE format($query$
    WITH filtered AS MATERIALIZED (
      SELECT gh.*
      FROM gacha_history gh
      WHERE %s
    ),
    daily AS (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object('date', day_key, 'count', draw_count)
        ORDER BY day_key
      ), '[]'::jsonb) AS rows
      FROM (
        SELECT
          to_char(date_trunc('day', redeemed_at), 'YYYY-MM-DD') AS day_key,
          COUNT(*)::INTEGER AS draw_count
        FROM filtered
        GROUP BY date_trunc('day', redeemed_at)
      ) d
    ),
    rarities AS (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'name', upper(left(rarity, 1)) || substring(rarity from 2),
          'value', draw_count,
          'rarity', rarity
        )
        ORDER BY draw_count DESC, rarity
      ), '[]'::jsonb) AS rows
      FROM (
        SELECT c.rarity, COUNT(*)::INTEGER AS draw_count
        FROM filtered gh
        JOIN cards c ON c.id = gh.card_id
        GROUP BY c.rarity
        HAVING COUNT(*) > 0
      ) r
    ),
    popular AS (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'card', jsonb_build_object(
            'id', c.id,
            'name', c.name,
            'rarity', c.rarity,
            'image_url', c.image_url
          ),
          'count', ranked.draw_count
        )
        ORDER BY ranked.draw_count DESC, c.name
      ), '[]'::jsonb) AS rows
      FROM (
        SELECT card_id, COUNT(*)::INTEGER AS draw_count
        FROM filtered
        GROUP BY card_id
        ORDER BY COUNT(*) DESC
        LIMIT 10
      ) ranked
      JOIN cards c ON c.id = ranked.card_id
    )
    SELECT jsonb_build_object(
      'totalGacha', (SELECT COUNT(*)::INTEGER FROM filtered),
      'uniqueUsers', (SELECT COUNT(DISTINCT user_twitch_id)::INTEGER FROM filtered),
      'legendaryCount', (
        SELECT COUNT(*)::INTEGER
        FROM filtered gh
        JOIN cards c ON c.id = gh.card_id
        WHERE c.rarity = 'legendary'
      ),
      'dailyGachaData', (SELECT rows FROM daily),
      'rarityDistribution', (SELECT rows FROM rarities),
      'popularCards', (SELECT rows FROM popular)
    )
  $query$, v_filter)
  INTO v_result
  USING p_from_date, p_streamer_id;

  RETURN v_result;
END;
$$;

-- 検索条件をNULL/空文字のORと同じWHERE句へ混ぜると、PostgreSQLの
-- パラメータ化されたRPCでは「検索あり」の実行でも条件全体が汎用的な
-- OR式として残り、pg_trgmのGIN索引よりSeq Scanを選ぶことがある。
-- 検索あり／なしをPL/pgSQLで分岐し、検索あり側には検索述語だけを渡す。
-- 一覧RPCへUUIDだけを返して元テーブルへ再JOINすると、PL/pgSQLのSET返却行数
-- 推定値によって候補数が多いと判断され、元テーブル全件のSeq Scanへ戻る場合がある。
-- そのため候補行そのものを返し、一覧RPCはusers/streamersを再走査しない。
-- 内部ヘルパーはPUBLICへ公開しない。
CREATE OR REPLACE FUNCTION get_analysis_user_candidate_rows(
  p_search TEXT DEFAULT NULL
)
RETURNS SETOF users
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_search IS NULL OR p_search = '' THEN
    RETURN QUERY
    SELECT u.*
    FROM users u;
  ELSE
    RETURN QUERY
    SELECT u.*
    FROM users u
    WHERE u.twitch_username ILIKE p_search ESCAPE E'\\'
      OR u.twitch_display_name ILIKE p_search ESCAPE E'\\';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION get_analysis_streamer_candidate_rows(
  p_search TEXT DEFAULT NULL,
  p_filter_chat_enabled BOOLEAN DEFAULT FALSE,
  p_filter_has_template BOOLEAN DEFAULT FALSE
)
RETURNS SETOF streamers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_search IS NULL OR p_search = '' THEN
    RETURN QUERY
    SELECT s.*
    FROM streamers s
    WHERE (NOT COALESCE(p_filter_chat_enabled, FALSE) OR s.chat_announcement_enabled)
      AND (NOT COALESCE(p_filter_has_template, FALSE)
        OR COALESCE(length(s.chat_announcement_template), 0) > 0);
  ELSE
    RETURN QUERY
    SELECT s.*
    FROM streamers s
    WHERE (
        s.twitch_username ILIKE p_search ESCAPE E'\\'
        OR s.twitch_display_name ILIKE p_search ESCAPE E'\\'
        OR s.twitch_user_id ILIKE p_search ESCAPE E'\\'
      )
      AND (NOT COALESCE(p_filter_chat_enabled, FALSE) OR s.chat_announcement_enabled)
      AND (NOT COALESCE(p_filter_has_template, FALSE)
        OR COALESCE(length(s.chat_announcement_template), 0) > 0);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION get_analysis_users_page(
  p_page INTEGER DEFAULT 1,
  p_page_size INTEGER DEFAULT 20,
  p_search TEXT DEFAULT NULL,
  p_sort TEXT DEFAULT 'card_count_desc',
  p_hide_zero_cards BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
WITH candidate_users AS MATERIALIZED (
  SELECT
    u.id,
    u.twitch_user_id,
    u.twitch_username,
    u.twitch_display_name,
    u.twitch_profile_image_url,
    u.tos_accepted_at,
    COALESCE(u.twitch_scopes, '{}'::TEXT[]) AS twitch_scopes,
    u.created_at,
    u.updated_at
  FROM get_analysis_user_candidate_rows(p_search) AS u
),
card_counts AS MATERIALIZED (
  SELECT uc.user_id, COUNT(*)::INTEGER AS card_count
  FROM user_cards uc
  JOIN candidate_users cu ON cu.id = uc.user_id
  GROUP BY uc.user_id
),
filtered_users AS MATERIALIZED (
  SELECT
    cu.*,
    COALESCE(cc.card_count, 0)::INTEGER AS card_count
  FROM candidate_users cu
  LEFT JOIN card_counts cc ON cc.user_id = cu.id
  WHERE NOT COALESCE(p_hide_zero_cards, FALSE)
    OR COALESCE(cc.card_count, 0) > 0
),
paged_users AS (
  SELECT fu.*
  FROM filtered_users fu
  ORDER BY
    CASE WHEN p_sort = 'card_count_desc' THEN fu.card_count END DESC NULLS LAST,
    CASE WHEN p_sort = 'card_count_asc' THEN fu.card_count END ASC NULLS LAST,
    CASE WHEN p_sort = 'name_asc' THEN fu.twitch_display_name END ASC NULLS LAST,
    fu.created_at DESC,
    fu.id ASC
  LIMIT LEAST(GREATEST(COALESCE(p_page_size, 20), 1), 100)
  OFFSET (GREATEST(COALESCE(p_page, 1), 1)::BIGINT - 1)
    * LEAST(GREATEST(COALESCE(p_page_size, 20), 1), 100)::BIGINT
)
SELECT jsonb_build_object(
  'rows', COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'id', pu.id,
        'twitch_user_id', pu.twitch_user_id,
        'twitch_username', pu.twitch_username,
        'twitch_display_name', pu.twitch_display_name,
        'twitch_profile_image_url', pu.twitch_profile_image_url,
        'tos_accepted_at', pu.tos_accepted_at,
        'twitch_scopes', pu.twitch_scopes,
        'created_at', pu.created_at,
        'updated_at', pu.updated_at,
        'user_cards', jsonb_build_array(jsonb_build_object('count', pu.card_count))
      )
      ORDER BY
        CASE WHEN p_sort = 'card_count_desc' THEN pu.card_count END DESC NULLS LAST,
        CASE WHEN p_sort = 'card_count_asc' THEN pu.card_count END ASC NULLS LAST,
        CASE WHEN p_sort = 'name_asc' THEN pu.twitch_display_name END ASC NULLS LAST,
        pu.created_at DESC,
        pu.id ASC
    )
    FROM paged_users pu
  ), '[]'::JSONB),
  'count', (SELECT COUNT(*)::INTEGER FROM filtered_users)
);
$$;

-- ページ移動・検索・ソートのたびにglobal summaryまで再集計すると、一覧RPCの
-- 軽量化効果を全体集計が打ち消す。summaryはページとは独立した一度の取得に分け、
-- UI側で画面表示中に保持する。データ更新後は画面の再試行で明示的に再取得する。
CREATE OR REPLACE FUNCTION get_analysis_users_summary()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
WITH user_totals AS (
  SELECT
    COUNT(*)::INTEGER AS total_users,
    COUNT(*) FILTER (WHERE u.tos_accepted_at IS NOT NULL)::INTEGER AS users_with_tos
  FROM users u
),
user_card_totals AS (
  SELECT
    COUNT(*)::INTEGER AS total_cards,
    COUNT(DISTINCT uc.user_id)::INTEGER AS users_with_cards
  FROM user_cards uc
)
SELECT jsonb_build_object(
  'totalUsers', ut.total_users,
  'totalCards', uct.total_cards,
  'usersWithTos', ut.users_with_tos,
  'usersWithCards', uct.users_with_cards
)
FROM user_totals ut
CROSS JOIN user_card_totals uct;
$$;

CREATE OR REPLACE FUNCTION get_analysis_streamers_page(
  p_page INTEGER DEFAULT 1,
  p_page_size INTEGER DEFAULT 20,
  p_search TEXT DEFAULT NULL,
  p_sort TEXT DEFAULT 'card_count_desc',
  p_hide_zero_cards BOOLEAN DEFAULT FALSE,
  p_filter_chat_enabled BOOLEAN DEFAULT FALSE,
  p_filter_has_template BOOLEAN DEFAULT FALSE,
  p_filter_missing_scope BOOLEAN DEFAULT FALSE,
  p_filter_vote_campaign BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_candidate_where TEXT;
  v_result JSONB;
BEGIN
  -- 検索述語をSET返却functionの内側へ隠すと、呼び出し側plannerは常に
  -- 既定1000行のSRFと判断し、広範囲検索でも不適切なjoin方式を選ぶことがある。
  -- 検索あり／なしでWHERE句という固定SQL fragmentだけを分け、検索値自体は
  -- $3でバインドする。これにより少数検索ではGIN、広範囲検索ではSeq Scan/Hash
  -- Joinをplannerが選択できる。fragmentへ利用者入力を連結しないためSQL injection
  -- の経路も作らない。
  IF p_search IS NULL OR p_search = '' THEN
    v_candidate_where := $where$
      WHERE (NOT COALESCE($4, FALSE) OR s.chat_announcement_enabled)
        AND (NOT COALESCE($5, FALSE)
          OR COALESCE(length(s.chat_announcement_template), 0) > 0)
    $where$;
  ELSE
    v_candidate_where := $where$
      WHERE (
          s.twitch_username ILIKE $3 ESCAPE E'\\'
          OR s.twitch_display_name ILIKE $3 ESCAPE E'\\'
          OR s.twitch_user_id ILIKE $3 ESCAPE E'\\'
        )
        AND (NOT COALESCE($4, FALSE) OR s.chat_announcement_enabled)
        AND (NOT COALESCE($5, FALSE)
          OR COALESCE(length(s.chat_announcement_template), 0) > 0)
    $where$;
  END IF;

  EXECUTE format($query$
WITH candidate_streamers AS MATERIALIZED (
  SELECT s.*
  FROM streamers s
  %s
),
candidate_card_counts AS MATERIALIZED (
  SELECT c.streamer_id, COUNT(*)::INTEGER AS card_count
  FROM cards c
  JOIN candidate_streamers cs ON cs.id = c.streamer_id
  GROUP BY c.streamer_id
),
candidate_vote_campaign_bonus AS MATERIALIZED (
  SELECT DISTINCT b.streamer_id
  FROM streamer_storage_bonus b
  JOIN candidate_streamers cs ON cs.id = b.streamer_id
  WHERE b.type = 'campaign'
    AND b.memo = '2026選挙応援'
),
system_bot AS (
  SELECT EXISTS (
    SELECT 1
    FROM twitch_bot_accounts
    WHERE owner_type = 'system'
      AND status = 'active'
  ) AS has_active_system_bot
),
streamer_base AS MATERIALIZED (
  SELECT
    s.*,
    COALESCE(cc.card_count, 0)::INTEGER AS card_count,
    COALESCE(su.bytes_used, 0)::BIGINT AS storage_bytes,
    COALESCE(u.twitch_scopes, '{}'::TEXT[]) @> ARRAY['user:write:chat']::TEXT[] AS has_chat_scope,
    COALESCE(css.sender_mode, 'streamer') AS chat_sender_mode,
    CASE
      WHEN COALESCE(css.sender_mode, 'streamer') = 'custom_bot' THEN
        COALESCE(bot.owner_type = 'streamer'
          AND bot.streamer_id = s.id
          AND bot.status = 'active', FALSE)
      WHEN COALESCE(css.sender_mode, 'streamer') = 'official_bot' THEN
        (SELECT has_active_system_bot FROM system_bot)
      ELSE FALSE
    END AS has_active_bot_sender,
    (
      (COALESCE(u.twitch_scopes, '{}'::TEXT[]) @> ARRAY['user:write:chat']::TEXT[])
      OR CASE
        WHEN COALESCE(css.sender_mode, 'streamer') = 'custom_bot' THEN
          COALESCE(bot.owner_type = 'streamer'
            AND bot.streamer_id = s.id
            AND bot.status = 'active', FALSE)
        WHEN COALESCE(css.sender_mode, 'streamer') = 'official_bot' THEN
          (SELECT has_active_system_bot FROM system_bot)
        ELSE FALSE
      END
    ) AS chat_send_available,
    vcb.streamer_id IS NOT NULL AS has_vote_campaign_bonus
  FROM candidate_streamers s
  LEFT JOIN candidate_card_counts cc ON cc.streamer_id = s.id
  LEFT JOIN users u ON u.twitch_user_id = s.twitch_user_id
  LEFT JOIN streamer_chat_sender_settings css ON css.streamer_id = s.id
  LEFT JOIN twitch_bot_accounts bot ON bot.id = css.custom_bot_account_id
  LEFT JOIN storage_usage su
    ON su.user_prefix = substring(encode(extensions.digest(s.twitch_user_id, 'sha256'), 'hex') from 1 for 8)
  LEFT JOIN candidate_vote_campaign_bonus vcb ON vcb.streamer_id = s.id
),
filtered_streamers AS MATERIALIZED (
  SELECT sb.*
  FROM streamer_base sb
  WHERE (NOT COALESCE($7, FALSE) OR sb.card_count > 0)
    AND (NOT COALESCE($8, FALSE)
      OR (sb.chat_announcement_enabled AND NOT sb.chat_send_available))
    AND (NOT COALESCE($9, FALSE) OR sb.has_vote_campaign_bonus)
),
paged_streamers AS (
  SELECT fs.*
  FROM filtered_streamers fs
  ORDER BY
    CASE WHEN $6 = 'card_count_desc' THEN fs.card_count END DESC NULLS LAST,
    CASE WHEN $6 = 'card_count_asc' THEN fs.card_count END ASC NULLS LAST,
    CASE WHEN $6 = 'storage_desc' THEN fs.storage_bytes END DESC NULLS LAST,
    CASE WHEN $6 = 'name_asc' THEN fs.twitch_display_name END ASC NULLS LAST,
    fs.created_at DESC,
    fs.id ASC
  LIMIT LEAST(GREATEST(COALESCE($2, 20), 1), 100)
  OFFSET (GREATEST(COALESCE($1, 1), 1)::BIGINT - 1)
    * LEAST(GREATEST(COALESCE($2, 20), 1), 100)::BIGINT
)
SELECT jsonb_build_object(
  'rows', COALESCE((
    SELECT jsonb_agg(to_jsonb(ps) ORDER BY
      CASE WHEN $6 = 'card_count_desc' THEN ps.card_count END DESC NULLS LAST,
      CASE WHEN $6 = 'card_count_asc' THEN ps.card_count END ASC NULLS LAST,
      CASE WHEN $6 = 'storage_desc' THEN ps.storage_bytes END DESC NULLS LAST,
      CASE WHEN $6 = 'name_asc' THEN ps.twitch_display_name END ASC NULLS LAST,
      ps.created_at DESC,
      ps.id ASC
    ) FROM paged_streamers ps
  ), '[]'::JSONB),
  'count', (SELECT COUNT(*)::INTEGER FROM filtered_streamers)
)
  $query$, v_candidate_where)
  INTO v_result
  USING
    p_page,
    p_page_size,
    p_search,
    p_filter_chat_enabled,
    p_filter_has_template,
    p_sort,
    p_hide_zero_cards,
    p_filter_missing_scope,
    p_filter_vote_campaign;

  RETURN v_result;
END;
$$;

-- Streamers一覧のglobal summaryはページ移動・検索とは独立しているため、ページRPC
-- から分離する。カード、storage、チャット送信可否、投票キャンペーンの全体値は
-- このRPCを画面初回表示または再試行時だけ呼び出し、一覧RPCの毎回再集計を避ける。
CREATE OR REPLACE FUNCTION get_analysis_streamers_summary()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
WITH all_card_counts AS MATERIALIZED (
  SELECT c.streamer_id, COUNT(*)::INTEGER AS card_count
  FROM cards c
  GROUP BY c.streamer_id
),
all_vote_campaign_bonus AS MATERIALIZED (
  SELECT DISTINCT b.streamer_id
  FROM streamer_storage_bonus b
  WHERE b.type = 'campaign'
    AND b.memo = '2026選挙応援'
),
system_bot AS (
  SELECT EXISTS (
    SELECT 1
    FROM twitch_bot_accounts
    WHERE owner_type = 'system'
      AND status = 'active'
  ) AS has_active_system_bot
),
summary_streamer_base AS MATERIALIZED (
  SELECT
    s.*,
    COALESCE(cc.card_count, 0)::INTEGER AS card_count,
    COALESCE(su.bytes_used, 0)::BIGINT AS storage_bytes,
    COALESCE(u.twitch_scopes, '{}'::TEXT[]) @> ARRAY['user:write:chat']::TEXT[] AS has_chat_scope,
    COALESCE(css.sender_mode, 'streamer') AS chat_sender_mode,
    CASE
      WHEN COALESCE(css.sender_mode, 'streamer') = 'custom_bot' THEN
        COALESCE(bot.owner_type = 'streamer'
          AND bot.streamer_id = s.id
          AND bot.status = 'active', FALSE)
      WHEN COALESCE(css.sender_mode, 'streamer') = 'official_bot' THEN
        (SELECT has_active_system_bot FROM system_bot)
      ELSE FALSE
    END AS has_active_bot_sender,
    (
      (COALESCE(u.twitch_scopes, '{}'::TEXT[]) @> ARRAY['user:write:chat']::TEXT[])
      OR CASE
        WHEN COALESCE(css.sender_mode, 'streamer') = 'custom_bot' THEN
          COALESCE(bot.owner_type = 'streamer'
            AND bot.streamer_id = s.id
            AND bot.status = 'active', FALSE)
        WHEN COALESCE(css.sender_mode, 'streamer') = 'official_bot' THEN
          (SELECT has_active_system_bot FROM system_bot)
        ELSE FALSE
      END
    ) AS chat_send_available,
    vcb.streamer_id IS NOT NULL AS has_vote_campaign_bonus
  FROM streamers s
  LEFT JOIN all_card_counts cc ON cc.streamer_id = s.id
  LEFT JOIN users u ON u.twitch_user_id = s.twitch_user_id
  LEFT JOIN streamer_chat_sender_settings css ON css.streamer_id = s.id
  LEFT JOIN twitch_bot_accounts bot ON bot.id = css.custom_bot_account_id
  LEFT JOIN storage_usage su
    ON su.user_prefix = substring(encode(extensions.digest(s.twitch_user_id, 'sha256'), 'hex') from 1 for 8)
  LEFT JOIN all_vote_campaign_bonus vcb ON vcb.streamer_id = s.id
)
SELECT jsonb_build_object(
  'totalStreamers', COUNT(*)::INTEGER,
  'activeStreamers', COUNT(*) FILTER (WHERE sb.is_active)::INTEGER,
  'configuredStreamers', COUNT(*) FILTER (
    WHERE COALESCE(length(sb.channel_point_reward_id), 0) > 0
  )::INTEGER,
  'totalCards', COALESCE(SUM(sb.card_count), 0)::INTEGER,
  'totalStorage', COALESCE(SUM(sb.storage_bytes), 0)::BIGINT,
  'streamersWithCards', COUNT(*) FILTER (WHERE sb.card_count > 0)::INTEGER,
  'chatEnabledStreamers', COUNT(*) FILTER (WHERE sb.chat_announcement_enabled)::INTEGER,
  'customTemplateStreamers', COUNT(*) FILTER (
    WHERE COALESCE(length(sb.chat_announcement_template), 0) > 0
  )::INTEGER,
  'chatEnabledNoSender', COUNT(*) FILTER (
    WHERE sb.chat_announcement_enabled AND NOT sb.chat_send_available
  )::INTEGER,
  'voteCampaignUsers', COUNT(*) FILTER (WHERE sb.has_vote_campaign_bonus)::INTEGER
)
FROM summary_streamer_base sb;
$$;

CREATE OR REPLACE FUNCTION get_analysis_streamer_options_page(
  p_page INTEGER DEFAULT 1,
  p_page_size INTEGER DEFAULT 50,
  p_search TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
WITH filtered AS MATERIALIZED (
  SELECT s.id, s.twitch_username, s.twitch_display_name
  FROM get_analysis_streamer_candidate_rows(p_search, FALSE, FALSE) AS s
),
paged AS (
  SELECT f.*
  FROM filtered f
  ORDER BY f.twitch_display_name ASC, f.id ASC
  LIMIT LEAST(GREATEST(COALESCE(p_page_size, 50), 1), 100)
  OFFSET (GREATEST(COALESCE(p_page, 1), 1)::BIGINT - 1)
    * LEAST(GREATEST(COALESCE(p_page_size, 50), 1), 100)::BIGINT
)
SELECT jsonb_build_object(
  'rows', COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'id', p.id,
        'twitch_username', p.twitch_username,
        'twitch_display_name', p.twitch_display_name
      ) ORDER BY p.twitch_display_name ASC, p.id ASC
    ) FROM paged p
  ), '[]'::JSONB),
  'count', (SELECT COUNT(*)::INTEGER FROM filtered)
);
$$;

REVOKE ALL ON FUNCTION get_analysis_overview() FROM PUBLIC;
REVOKE ALL ON FUNCTION get_analysis_user_candidate_rows(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_analysis_streamer_candidate_rows(TEXT, BOOLEAN, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_analysis_users_page(INTEGER, INTEGER, TEXT, TEXT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_analysis_users_summary() FROM PUBLIC;
REVOKE ALL ON FUNCTION get_analysis_streamers_page(INTEGER, INTEGER, TEXT, TEXT, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_analysis_streamers_summary() FROM PUBLIC;
REVOKE ALL ON FUNCTION get_analysis_streamer_options_page(INTEGER, INTEGER, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION get_analysis_overview() TO service_role;
GRANT EXECUTE ON FUNCTION get_analysis_user_candidate_rows(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION get_analysis_streamer_candidate_rows(TEXT, BOOLEAN, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION get_analysis_users_page(INTEGER, INTEGER, TEXT, TEXT, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION get_analysis_users_summary() TO service_role;
GRANT EXECUTE ON FUNCTION get_analysis_streamers_page(INTEGER, INTEGER, TEXT, TEXT, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION get_analysis_streamers_summary() TO service_role;
GRANT EXECUTE ON FUNCTION get_analysis_streamer_options_page(INTEGER, INTEGER, TEXT) TO service_role;
