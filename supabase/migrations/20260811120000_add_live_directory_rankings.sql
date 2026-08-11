-- migration-transaction: required
-- migration-providers: planetscale
--
-- #740: /live の全配信者ランキング
--
-- publish_stats は初回リリース前の仕様変更により「統計値を公開するか」ではなく、
-- ランキング上でチャネルを識別可能にするかを表す。集計値は全アクティブ配信者を
-- 対象にする一方、OFFの行はこのRPCの時点で識別情報をNULLにする。クライアントへ
-- streamer_id等を渡してから隠す方式では、RSC payloadから復元できてしまうため不可。
COMMENT ON COLUMN streamers.publish_stats IS
  '/liveランキングでチャネル名・画像・リンクを表示するオプトイン (issue #740)';

-- 初回/live実装のRPCはカード統計をライブ行へ付けていたが、ランキング分離後は
-- クライアントがその値を使わない。公開同意済みチャネルのTwitch照合に必要な列だけ
-- 返す形へ置換し、/live取得ごとのcards/usage集計と不要なpayloadを解消する。
CREATE OR REPLACE FUNCTION get_live_directory_streamers()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
SELECT COALESCE(
  jsonb_agg(
    jsonb_build_object(
      'streamerId', s.id,
      'twitchUserId', s.twitch_user_id,
      'twitchDisplayName', s.twitch_display_name,
      'twitchProfileImageUrl', s.twitch_profile_image_url
    )
    ORDER BY s.twitch_display_name, s.id
  ),
  '[]'::JSONB
)
FROM streamers s
WHERE s.publish_live_status = TRUE
  AND s.is_active = TRUE;
$$;

COMMENT ON FUNCTION get_live_directory_streamers() IS
  '/live向け掲載オプトイン済み配信者。統計集計はランキングRPCへ分離 (issue #740)';

REVOKE ALL ON FUNCTION get_live_directory_streamers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_live_directory_streamers() TO service_role;

-- 公開ランキング用read RPC。1配信者につき1行の集計だけを返し、表示側で3指標を
-- 並べ替える。3ランキングをSQL側で別配列にすると同じidentityと集計値を3回返して
-- payloadが膨らむため、単一配列を60秒KVキャッシュしてクライアントで整列する。
--
-- cardCount: 有効カード種類数
-- redemptionCount: reward_cost > 0 のカード引き換え累計
-- totalPoints: 上記引き換えで使用されたチャネルポイント累計
CREATE OR REPLACE FUNCTION get_live_directory_rankings()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH card_counts AS (
  SELECT c.streamer_id, COUNT(*)::INTEGER AS card_count
  FROM cards c
  WHERE c.is_active
  GROUP BY c.streamer_id
),
usage_totals AS (
  SELECT
    us.streamer_id,
    COALESCE(SUM(us.redemption_count), 0)::BIGINT AS redemption_count,
    COALESCE(SUM(us.total_points), 0)::BIGINT AS total_points
  FROM channel_point_usage_stats us
  GROUP BY us.streamer_id
)
SELECT COALESCE(
  jsonb_agg(
    jsonb_build_object(
      'identity',
        CASE WHEN s.publish_stats THEN jsonb_build_object(
          'streamerId', s.id,
          'twitchLogin', s.twitch_username,
          'displayName', s.twitch_display_name,
          'profileImageUrl', s.twitch_profile_image_url
        ) ELSE NULL END,
      'cardCount', COALESCE(cc.card_count, 0),
      'redemptionCount', COALESCE(ut.redemption_count, 0),
      'totalPoints', COALESCE(ut.total_points, 0)
    )
    -- IDはレスポンスへ含めず、同値行のキャッシュ順を決定するためだけに使う。
    ORDER BY s.id
  ),
  '[]'::JSONB
)
FROM streamers s
LEFT JOIN card_counts cc ON cc.streamer_id = s.id
LEFT JOIN usage_totals ut ON ut.streamer_id = s.id
WHERE s.is_active = TRUE;
$$;

COMMENT ON FUNCTION get_live_directory_rankings() IS
  '/live向け全配信者ランキング集計。publish_stats=falseは識別情報を返さない (issue #740)';

REVOKE ALL ON FUNCTION get_live_directory_rankings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_live_directory_rankings() TO service_role;
