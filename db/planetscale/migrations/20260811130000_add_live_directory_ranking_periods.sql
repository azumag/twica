-- migration-transaction: required
-- migration-providers: planetscale
--
-- #740: /live ランキングへ「直近7日間 / 全期間」の集計期間を追加する。
--
-- 既存 get_live_directory_rankings() の返却形は変更しない。DB migration がアプリより
-- 先に適用されるデプロイ窓で旧アプリを壊さず、ロールバック時も旧RPCを使い続けられる
-- よう、期間対応は新しいRPCとして追加する。
--
-- 期間ごとの意味:
-- - cardCount / last7Days: 直近7日間に追加され、現在も有効なカード種類数
-- - cardCount / allTime: 現在有効なカード種類数（既存ランキングと同じ現在値）
-- - redemptionCount / totalPoints: 期間内の reward_cost > 0 の実引き換え集計
--
-- 7日間は関数実行時のCURRENT_TIMESTAMPを共通の境界時刻にする。各CTEでnow()を
-- 個別評価すると境界上の行が指標間で食い違う余地があるため、parameters CTEで1回だけ
-- 確定する。全期間の引き換え集計は既存の累積テーブルを使い、履歴全走査を避ける。
CREATE OR REPLACE FUNCTION get_live_directory_rankings_by_period()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH parameters AS (
  SELECT CURRENT_TIMESTAMP - INTERVAL '7 days' AS last_7_days_start
),
card_counts AS (
  SELECT
    c.streamer_id,
    COUNT(*) FILTER (WHERE c.is_active = TRUE)::INTEGER AS all_time_card_count,
    COUNT(*) FILTER (
      WHERE c.is_active = TRUE
        AND c.created_at >= parameters.last_7_days_start
    )::INTEGER AS last_7_days_card_count
  FROM cards c
  CROSS JOIN parameters
  GROUP BY c.streamer_id
),
all_time_usage AS (
  SELECT
    usage.streamer_id,
    COALESCE(SUM(usage.redemption_count), 0)::BIGINT AS redemption_count,
    COALESCE(SUM(usage.total_points), 0)::BIGINT AS total_points
  FROM channel_point_usage_stats usage
  GROUP BY usage.streamer_id
),
last_7_days_usage AS (
  SELECT
    history.streamer_id,
    COUNT(*)::BIGINT AS redemption_count,
    COALESCE(SUM(history.reward_cost), 0)::BIGINT AS total_points
  FROM gacha_history history
  CROSS JOIN parameters
  WHERE history.reward_cost > 0
    AND history.redeemed_at >= parameters.last_7_days_start
  GROUP BY history.streamer_id
),
aggregated AS (
  SELECT
    streamer.publish_stats,
    streamer.twitch_username,
    streamer.twitch_display_name,
    streamer.twitch_profile_image_url,
    COALESCE(cards.all_time_card_count, 0) AS all_time_card_count,
    COALESCE(cards.last_7_days_card_count, 0) AS last_7_days_card_count,
    COALESCE(all_usage.redemption_count, 0) AS all_time_redemption_count,
    COALESCE(all_usage.total_points, 0) AS all_time_total_points,
    COALESCE(recent_usage.redemption_count, 0) AS last_7_days_redemption_count,
    COALESCE(recent_usage.total_points, 0) AS last_7_days_total_points
  FROM streamers streamer
  LEFT JOIN card_counts cards ON cards.streamer_id = streamer.id
  LEFT JOIN all_time_usage all_usage ON all_usage.streamer_id = streamer.id
  LEFT JOIN last_7_days_usage recent_usage ON recent_usage.streamer_id = streamer.id
  WHERE streamer.is_active = TRUE
),
periodized AS (
  SELECT
    aggregated.publish_stats,
    aggregated.twitch_username,
    aggregated.twitch_display_name,
    aggregated.twitch_profile_image_url,
    period_values.period,
    period_values.card_count,
    period_values.redemption_count,
    period_values.total_points
  FROM aggregated
  CROSS JOIN LATERAL (
    VALUES
      (
        'last7Days'::TEXT,
        aggregated.last_7_days_card_count,
        aggregated.last_7_days_redemption_count,
        aggregated.last_7_days_total_points
      ),
      (
        'allTime'::TEXT,
        aggregated.all_time_card_count,
        aggregated.all_time_redemption_count,
        aggregated.all_time_total_points
      )
  ) AS period_values(period, card_count, redemption_count, total_points)
),
ranked AS (
  SELECT
    periodized.*,
    ROW_NUMBER() OVER (
      PARTITION BY periodized.period
      ORDER BY
        periodized.card_count DESC,
        periodized.redemption_count DESC,
        periodized.total_points DESC,
        CASE WHEN periodized.publish_stats THEN LOWER(periodized.twitch_username) END NULLS LAST,
        CASE WHEN periodized.publish_stats THEN periodized.twitch_username END NULLS LAST
    ) AS card_count_position,
    ROW_NUMBER() OVER (
      PARTITION BY periodized.period
      ORDER BY
        periodized.redemption_count DESC,
        periodized.total_points DESC,
        periodized.card_count DESC,
        CASE WHEN periodized.publish_stats THEN LOWER(periodized.twitch_username) END NULLS LAST,
        CASE WHEN periodized.publish_stats THEN periodized.twitch_username END NULLS LAST
    ) AS redemption_count_position,
    ROW_NUMBER() OVER (
      PARTITION BY periodized.period
      ORDER BY
        periodized.total_points DESC,
        periodized.redemption_count DESC,
        periodized.card_count DESC,
        CASE WHEN periodized.publish_stats THEN LOWER(periodized.twitch_username) END NULLS LAST,
        CASE WHEN periodized.publish_stats THEN periodized.twitch_username END NULLS LAST
    ) AS total_points_position
  FROM periodized
),
selected AS (
  SELECT
    ranked.*,
    ARRAY_REMOVE(ARRAY[
      CASE
        WHEN ranked.card_count > 0 AND ranked.card_count_position <= 100
        THEN 'cardCount'
      END,
      CASE
        WHEN ranked.redemption_count > 0 AND ranked.redemption_count_position <= 100
        THEN 'redemptionCount'
      END,
      CASE
        WHEN ranked.total_points > 0 AND ranked.total_points_position <= 100
        THEN 'totalPoints'
      END
    ]::TEXT[], NULL) AS ranked_metrics
  FROM ranked
),
period_catalog(period, sort_order) AS (
  VALUES ('last7Days'::TEXT, 1), ('allTime'::TEXT, 2)
),
period_payloads AS (
  SELECT
    period_catalog.period,
    period_catalog.sort_order,
    COALESCE(
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
        -- 匿名行を内部ID順にすると既知IDとの相対位置が識別の手掛かりになるため、
        -- 既存RPCと同じく公開値だけでレスポンス順を決める。
        ORDER BY
          selected.card_count DESC,
          selected.redemption_count DESC,
          selected.total_points DESC,
          CASE WHEN selected.publish_stats THEN LOWER(selected.twitch_username) END NULLS LAST,
          CASE WHEN selected.publish_stats THEN selected.twitch_username END NULLS LAST
      ) FILTER (
        WHERE selected.period IS NOT NULL
          AND CARDINALITY(selected.ranked_metrics) > 0
      ),
      '[]'::JSONB
    ) AS entries
  FROM period_catalog
  LEFT JOIN selected ON selected.period = period_catalog.period
  GROUP BY period_catalog.period, period_catalog.sort_order
)
SELECT jsonb_object_agg(
  period_payloads.period,
  period_payloads.entries
  ORDER BY period_payloads.sort_order
)
FROM period_payloads;
$$;

COMMENT ON FUNCTION get_live_directory_rankings_by_period() IS
  '/live向け直近7日間・全期間の各指標上位100件。publish_stats=falseは識別情報を返さない (issue #740)';

REVOKE ALL ON FUNCTION get_live_directory_rankings_by_period() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_live_directory_rankings_by_period() TO service_role;
