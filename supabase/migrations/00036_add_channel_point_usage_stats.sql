-- RPC: 配信者の期間内チャネルポイント使用ランキングをDB側で集約して返す
-- gacha_history.reward_cost は EventSub のチャネルポイント引き換えでのみ入るため、
-- NULL/0 以下の履歴はランキング対象外にする。
CREATE OR REPLACE FUNCTION get_channel_point_usage_stats(
  p_streamer_id UUID,
  p_from_date TIMESTAMPTZ,
  p_limit INTEGER DEFAULT 10
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_points BIGINT;
  v_ranking JSONB;
BEGIN
  SELECT COALESCE(SUM(reward_cost), 0)::BIGINT
  INTO v_total_points
  FROM gacha_history
  WHERE streamer_id = p_streamer_id
    AND redeemed_at >= p_from_date
    AND reward_cost IS NOT NULL
    AND reward_cost > 0;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'user_twitch_id', ranked.user_twitch_id,
      'username', ranked.username,
      'total_points', ranked.total_points,
      'redemption_count', ranked.redemption_count,
      'last_redeemed_at', ranked.last_redeemed_at
    )
    ORDER BY ranked.total_points DESC, ranked.redemption_count DESC, ranked.last_redeemed_at DESC
  ), '[]'::JSONB)
  INTO v_ranking
  FROM (
    SELECT
      user_twitch_id,
      COALESCE(MAX(user_twitch_username), user_twitch_id) AS username,
      SUM(reward_cost)::BIGINT AS total_points,
      COUNT(*)::INTEGER AS redemption_count,
      MAX(redeemed_at)::TEXT AS last_redeemed_at
    FROM gacha_history
    WHERE streamer_id = p_streamer_id
      AND redeemed_at >= p_from_date
      AND reward_cost IS NOT NULL
      AND reward_cost > 0
    GROUP BY user_twitch_id
    ORDER BY total_points DESC, redemption_count DESC, last_redeemed_at DESC
    LIMIT GREATEST(1, p_limit)
  ) ranked;

  RETURN jsonb_build_object(
    'total_points', v_total_points,
    'ranking', v_ranking
  );
END;
$$;

REVOKE ALL ON FUNCTION get_channel_point_usage_stats(UUID, TIMESTAMPTZ, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_channel_point_usage_stats(UUID, TIMESTAMPTZ, INTEGER) TO service_role;

CREATE INDEX IF NOT EXISTS idx_gacha_history_streamer_redeemed_reward
  ON gacha_history(streamer_id, redeemed_at DESC)
  WHERE reward_cost IS NOT NULL AND reward_cost > 0;
