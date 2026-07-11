-- analysis dashboard 用の読み取り RPC。
--
-- 背景:
--   analysis/dev/localAdminApi.ts で PostgREST の複数リクエストや大量行取得後の
--   Node.js 側集計を行うと、overview / users / streamers / gacha の初期表示が
--   データ量に比例して重くなる。ダッシュボード系の標準的な最適化は、表示に必要な
--   粒度まで DB 側で GROUP BY / COUNT / JSON 集約し、API には小さい集計済み
--   ペイロードだけを返すこと。ここでは既存 UI のレスポンス形状を保ったまま、
--   service_role 限定 RPC として集約処理を DB に移す。

CREATE EXTENSION IF NOT EXISTS pgcrypto;

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
user_growth AS (
  SELECT jsonb_agg(
    jsonb_build_object(
      'date', to_char(ds.day_start, 'YYYY-MM-DD'),
      'count', COALESCE(u.count, 0)
    )
    ORDER BY ds.day_start
  ) AS rows
  FROM day_series ds
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::INTEGER AS count
    FROM users u
    WHERE u.created_at >= ds.day_start
      AND u.created_at < ds.day_start + interval '1 day'
  ) u ON TRUE
),
gacha_growth AS (
  SELECT jsonb_agg(
    jsonb_build_object(
      'date', to_char(ds.day_start, 'YYYY-MM-DD'),
      'count', COALESCE(g.count, 0)
    )
    ORDER BY ds.day_start
  ) AS rows
  FROM day_series ds
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::INTEGER AS count
    FROM gacha_history gh
    WHERE gh.redeemed_at >= ds.day_start
      AND gh.redeemed_at < ds.day_start + interval '1 day'
  ) g ON TRUE
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

CREATE OR REPLACE FUNCTION get_analysis_streamer_leaderboard()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
WITH ranked AS (
  SELECT
    gh.streamer_id,
    COUNT(*)::INTEGER AS draw_count
  FROM gacha_history gh
  WHERE gh.redeemed_at >= now() - interval '30 days'
  GROUP BY gh.streamer_id
  ORDER BY COUNT(*) DESC
  LIMIT 10
)
SELECT COALESCE(jsonb_agg(
  jsonb_build_object(
    'streamerId', ranked.streamer_id,
    'displayName', COALESCE(s.twitch_display_name, 'Unknown'),
    'profileImageUrl', s.twitch_profile_image_url,
    'drawCount', ranked.draw_count
  )
  ORDER BY ranked.draw_count DESC
), '[]'::jsonb)
FROM ranked
LEFT JOIN streamers s ON s.id = ranked.streamer_id;
$$;

CREATE OR REPLACE FUNCTION get_analysis_users()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
WITH card_counts AS (
  SELECT user_id, COUNT(*)::INTEGER AS card_count
  FROM user_cards
  GROUP BY user_id
)
-- users.* を to_jsonb() で丸ごと展開すると、analysis側の Database 型に存在しない
-- twitch_access_token / twitch_refresh_token / twitch_token_expires_at 等の
-- 実カラム（migration 00004/00023で追加）まで analysis dashboard の JSON レスポンスに
-- 漏れてしまう。フロントエンドの User 型（analysis/src/types/database.ts）が実際に
-- 使う列だけを明示的に選択し、将来カラムが増えても自動で露出しないようにする。
SELECT COALESCE(jsonb_agg(
  jsonb_build_object(
    'id', u.id,
    'twitch_user_id', u.twitch_user_id,
    'twitch_username', u.twitch_username,
    'twitch_display_name', u.twitch_display_name,
    'twitch_profile_image_url', u.twitch_profile_image_url,
    'tos_accepted_at', u.tos_accepted_at,
    'twitch_scopes', u.twitch_scopes,
    'created_at', u.created_at,
    'updated_at', u.updated_at,
    'user_cards',
    jsonb_build_array(jsonb_build_object('count', COALESCE(cc.card_count, 0)))
  )
  ORDER BY u.created_at DESC
), '[]'::jsonb)
FROM users u
LEFT JOIN card_counts cc ON cc.user_id = u.id;
$$;

CREATE OR REPLACE FUNCTION get_analysis_streamers()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
WITH card_counts AS (
  SELECT streamer_id, COUNT(*)::INTEGER AS card_count
  FROM cards
  GROUP BY streamer_id
),
vote_campaign_bonus AS (
  SELECT DISTINCT streamer_id
  FROM streamer_storage_bonus
  WHERE type = 'campaign'
    AND memo = '2026選挙応援'
),
system_bot AS (
  SELECT EXISTS (
    SELECT 1
    FROM twitch_bot_accounts
    WHERE owner_type = 'system'
      AND status = 'active'
  ) AS has_active_system_bot
)
SELECT COALESCE(jsonb_agg(
  to_jsonb(s.*)
    || jsonb_build_object(
      'card_count', COALESCE(cc.card_count, 0),
      'storage_bytes', COALESCE(su.bytes_used, 0),
      'has_chat_scope', COALESCE(u.twitch_scopes, '{}'::text[]) @> ARRAY['user:write:chat']::text[],
      'chat_sender_mode', COALESCE(css.sender_mode, 'streamer'),
      'has_active_bot_sender',
        CASE
          WHEN COALESCE(css.sender_mode, 'streamer') = 'custom_bot' THEN
            COALESCE(bot.owner_type = 'streamer'
              AND bot.streamer_id = s.id
              AND bot.status = 'active', FALSE)
          WHEN COALESCE(css.sender_mode, 'streamer') = 'official_bot' THEN
            (SELECT has_active_system_bot FROM system_bot)
          ELSE FALSE
        END,
      'chat_send_available',
        (COALESCE(u.twitch_scopes, '{}'::text[]) @> ARRAY['user:write:chat']::text[])
        OR CASE
          WHEN COALESCE(css.sender_mode, 'streamer') = 'custom_bot' THEN
            COALESCE(bot.owner_type = 'streamer'
              AND bot.streamer_id = s.id
              AND bot.status = 'active', FALSE)
          WHEN COALESCE(css.sender_mode, 'streamer') = 'official_bot' THEN
            (SELECT has_active_system_bot FROM system_bot)
          ELSE FALSE
        END,
      'has_vote_campaign_bonus', vcb.streamer_id IS NOT NULL
    )
  ORDER BY s.created_at DESC, s.id ASC
), '[]'::jsonb)
FROM streamers s
LEFT JOIN card_counts cc ON cc.streamer_id = s.id
LEFT JOIN users u ON u.twitch_user_id = s.twitch_user_id
LEFT JOIN streamer_chat_sender_settings css ON css.streamer_id = s.id
LEFT JOIN twitch_bot_accounts bot ON bot.id = css.custom_bot_account_id
-- digest() は pgcrypto 由来で、Supabase のデフォルト構成では public ではなく
-- extensions スキーマにインストールされる。本関数は SET search_path = public
-- (SECURITY DEFINER の search_path 固定によるインジェクション対策) のため、
-- search_path を広げる代わりに呼び出し側を extensions.digest(...) と明示修飾する。
LEFT JOIN storage_usage su
  ON su.user_prefix = substring(encode(extensions.digest(s.twitch_user_id, 'sha256'), 'hex') from 1 for 8)
LEFT JOIN vote_campaign_bonus vcb ON vcb.streamer_id = s.id;
$$;

CREATE OR REPLACE FUNCTION get_analysis_gacha_summary(
  p_from_date TIMESTAMPTZ DEFAULT NULL,
  p_streamer_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
WITH filtered AS (
  SELECT gh.*
  FROM gacha_history gh
  WHERE (p_from_date IS NULL OR gh.redeemed_at >= p_from_date)
    AND (p_streamer_id IS NULL OR gh.streamer_id = p_streamer_id)
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
);
$$;

REVOKE ALL ON FUNCTION get_analysis_overview() FROM PUBLIC;
REVOKE ALL ON FUNCTION get_analysis_streamer_leaderboard() FROM PUBLIC;
REVOKE ALL ON FUNCTION get_analysis_users() FROM PUBLIC;
REVOKE ALL ON FUNCTION get_analysis_streamers() FROM PUBLIC;
REVOKE ALL ON FUNCTION get_analysis_gacha_summary(TIMESTAMPTZ, UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION get_analysis_overview() TO service_role;
GRANT EXECUTE ON FUNCTION get_analysis_streamer_leaderboard() TO service_role;
GRANT EXECUTE ON FUNCTION get_analysis_users() TO service_role;
GRANT EXECUTE ON FUNCTION get_analysis_streamers() TO service_role;
GRANT EXECUTE ON FUNCTION get_analysis_gacha_summary(TIMESTAMPTZ, UUID) TO service_role;
