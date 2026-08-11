-- migration-transaction: required
-- migration-providers: planetscale
--
-- #740: /live の全配信者ランキング
--
-- publish_stats は初回リリース前の仕様変更により「統計値を公開するか」ではなく、
-- ランキング上でチャネルを識別可能にするかを表す。このmigrationと設定列を追加する
-- 直前のmigrationは同じ初回本番リリースに含めるため、旧ラベルへの同意済みデータを
-- 読み替える移行は発生しない。集計値は全アクティブ配信者を対象にする一方、OFFの行は
-- このRPCの時点で識別情報をNULLにする。クライアントへstreamer_id等を渡してから隠す
-- 方式では、RSC payloadから復元できてしまうため不可。
COMMENT ON COLUMN streamers.publish_stats IS
  '/liveランキングでチャネル名・画像・リンクを表示するオプトイン (issue #740)';

-- 既存get_live_directory_streamers()は、このmigrationがアプリより先に適用される
-- デプロイ窓で旧アプリがpublishStats/cardCount/redemptionCountを読み続けられるよう
-- 返却形状を維持する。新アプリはKV/RSC境界のホワイトリストで旧fieldを除去する。
-- 不要集計の削除は新アプリが全環境へ反映された後のcontract migrationへ分離する。

-- 公開ランキング用read RPC。各指標の正値上位100件の和集合を1配信者1行で返し、
-- rankedMetricsでその行を表示するランキングを指定する。3ランキングをSQL側で
-- 別配列にすると同じidentityと集計値を3回返してpayloadが膨らむため、単一配列を
-- 60秒KVキャッシュしてクライアントで整列する。
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
),
aggregated AS (
  SELECT
    s.publish_stats,
    s.twitch_username,
    s.twitch_display_name,
    s.twitch_profile_image_url,
    COALESCE(cc.card_count, 0) AS card_count,
    COALESCE(ut.redemption_count, 0) AS redemption_count,
    COALESCE(ut.total_points, 0) AS total_points
  FROM streamers s
  LEFT JOIN card_counts cc ON cc.streamer_id = s.id
  LEFT JOIN usage_totals ut ON ut.streamer_id = s.id
  WHERE s.is_active = TRUE
),
ranked AS (
  SELECT
    a.*,
    ROW_NUMBER() OVER (
      ORDER BY
        a.card_count DESC,
        a.redemption_count DESC,
        a.total_points DESC,
        CASE WHEN a.publish_stats THEN LOWER(a.twitch_username) END NULLS LAST,
        CASE WHEN a.publish_stats THEN a.twitch_username END NULLS LAST
    ) AS card_count_position,
    ROW_NUMBER() OVER (
      ORDER BY
        a.redemption_count DESC,
        a.total_points DESC,
        a.card_count DESC,
        CASE WHEN a.publish_stats THEN LOWER(a.twitch_username) END NULLS LAST,
        CASE WHEN a.publish_stats THEN a.twitch_username END NULLS LAST
    ) AS redemption_count_position,
    ROW_NUMBER() OVER (
      ORDER BY
        a.total_points DESC,
        a.redemption_count DESC,
        a.card_count DESC,
        CASE WHEN a.publish_stats THEN LOWER(a.twitch_username) END NULLS LAST,
        CASE WHEN a.publish_stats THEN a.twitch_username END NULLS LAST
    ) AS total_points_position
  FROM aggregated a
),
selected AS (
  SELECT
    r.*,
    ARRAY_REMOVE(ARRAY[
      CASE
        WHEN r.card_count > 0 AND r.card_count_position <= 100
        THEN 'cardCount'
      END,
      CASE
        WHEN r.redemption_count > 0 AND r.redemption_count_position <= 100
        THEN 'redemptionCount'
      END,
      CASE
        WHEN r.total_points > 0 AND r.total_points_position <= 100
        THEN 'totalPoints'
      END
    ]::TEXT[], NULL) AS ranked_metrics
  FROM ranked r
)
SELECT COALESCE(
  jsonb_agg(
    jsonb_build_object(
      'identity',
        CASE WHEN selected.publish_stats THEN jsonb_build_object(
          'twitchLogin', selected.twitch_username,
          'displayName', selected.twitch_display_name,
          'profileImageUrl', selected.twitch_profile_image_url
        ) ELSE NULL END,
      'cardCount', selected.card_count,
      'redemptionCount', selected.redemption_count,
      'totalPoints', selected.total_points,
      'rankedMetrics', selected.ranked_metrics
    )
    -- 匿名行を内部ID順にすると、既知IDとの相対位置から本人を絞り込める。
    -- 集計値が同じ匿名行はレスポンス上も同一なので、公開値のみで順序を決める。
    ORDER BY
      selected.card_count DESC,
      selected.redemption_count DESC,
      selected.total_points DESC,
      CASE WHEN selected.publish_stats THEN LOWER(selected.twitch_username) END NULLS LAST,
      CASE WHEN selected.publish_stats THEN selected.twitch_username END NULLS LAST
  ),
  '[]'::JSONB
)
FROM selected
WHERE CARDINALITY(selected.ranked_metrics) > 0;
$$;

COMMENT ON FUNCTION get_live_directory_rankings() IS
  '/live向け各指標上位100件のランキング集計。publish_stats=falseは識別情報を返さない (issue #740)';

REVOKE ALL ON FUNCTION get_live_directory_rankings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_live_directory_rankings() TO service_role;
