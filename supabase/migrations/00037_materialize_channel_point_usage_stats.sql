-- チャネルポイント使用ランキングは全期間集計として表示するため、
-- リクエストごとに gacha_history 全体を GROUP BY しないよう累積テーブルを持つ。
CREATE TABLE IF NOT EXISTS channel_point_usage_stats (
  streamer_id UUID NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  user_twitch_id TEXT NOT NULL,
  username TEXT,
  total_points BIGINT NOT NULL DEFAULT 0 CHECK (total_points >= 0),
  redemption_count INTEGER NOT NULL DEFAULT 0 CHECK (redemption_count >= 0),
  last_redeemed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (streamer_id, user_twitch_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_point_usage_stats_streamer_rank
  ON channel_point_usage_stats(
    streamer_id,
    total_points DESC,
    redemption_count DESC,
    last_redeemed_at DESC
  );

CREATE INDEX IF NOT EXISTS idx_gacha_history_streamer_user_reward
  ON gacha_history(streamer_id, user_twitch_id)
  WHERE reward_cost IS NOT NULL AND reward_cost > 0;

INSERT INTO channel_point_usage_stats (
  streamer_id,
  user_twitch_id,
  username,
  total_points,
  redemption_count,
  last_redeemed_at
)
SELECT
  streamer_id,
  user_twitch_id,
  COALESCE(MAX(user_twitch_username), user_twitch_id) AS username,
  SUM(reward_cost)::BIGINT AS total_points,
  COUNT(*)::INTEGER AS redemption_count,
  MAX(redeemed_at) AS last_redeemed_at
FROM gacha_history
WHERE reward_cost IS NOT NULL
  AND reward_cost > 0
GROUP BY streamer_id, user_twitch_id
ON CONFLICT (streamer_id, user_twitch_id) DO UPDATE SET
  username = EXCLUDED.username,
  total_points = EXCLUDED.total_points,
  redemption_count = EXCLUDED.redemption_count,
  last_redeemed_at = EXCLUDED.last_redeemed_at,
  updated_at = NOW();

CREATE OR REPLACE FUNCTION refresh_channel_point_usage_stat(
  p_streamer_id UUID,
  p_user_twitch_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_username TEXT;
  v_total_points BIGINT;
  v_redemption_count INTEGER;
  v_last_redeemed_at TIMESTAMPTZ;
BEGIN
  IF p_streamer_id IS NULL OR p_user_twitch_id IS NULL THEN
    RETURN;
  END IF;

  SELECT
    COALESCE(MAX(user_twitch_username), p_user_twitch_id),
    COALESCE(SUM(reward_cost), 0)::BIGINT,
    COUNT(*)::INTEGER,
    MAX(redeemed_at)
  INTO
    v_username,
    v_total_points,
    v_redemption_count,
    v_last_redeemed_at
  FROM gacha_history
  WHERE streamer_id = p_streamer_id
    AND user_twitch_id = p_user_twitch_id
    AND reward_cost IS NOT NULL
    AND reward_cost > 0;

  IF v_redemption_count = 0 THEN
    DELETE FROM channel_point_usage_stats
    WHERE streamer_id = p_streamer_id
      AND user_twitch_id = p_user_twitch_id;
    RETURN;
  END IF;

  INSERT INTO channel_point_usage_stats (
    streamer_id,
    user_twitch_id,
    username,
    total_points,
    redemption_count,
    last_redeemed_at
  )
  VALUES (
    p_streamer_id,
    p_user_twitch_id,
    v_username,
    v_total_points,
    v_redemption_count,
    v_last_redeemed_at
  )
  ON CONFLICT (streamer_id, user_twitch_id) DO UPDATE SET
    username = EXCLUDED.username,
    total_points = EXCLUDED.total_points,
    redemption_count = EXCLUDED.redemption_count,
    last_redeemed_at = EXCLUDED.last_redeemed_at,
    updated_at = NOW();
END;
$$;

CREATE OR REPLACE FUNCTION sync_channel_point_usage_stat()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM refresh_channel_point_usage_stat(OLD.streamer_id, OLD.user_twitch_id);
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM refresh_channel_point_usage_stat(NEW.streamer_id, NEW.user_twitch_id);
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_channel_point_usage_stat ON gacha_history;
CREATE TRIGGER trg_sync_channel_point_usage_stat
AFTER INSERT OR UPDATE OR DELETE ON gacha_history
FOR EACH ROW
EXECUTE FUNCTION sync_channel_point_usage_stat();

CREATE OR REPLACE FUNCTION get_channel_point_usage_stats(
  p_streamer_id UUID,
  p_from_date TIMESTAMPTZ DEFAULT NULL,
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
  IF p_from_date IS NULL THEN
    SELECT COALESCE(SUM(total_points), 0)::BIGINT
    INTO v_total_points
    FROM channel_point_usage_stats
    WHERE streamer_id = p_streamer_id;

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
        COALESCE(username, user_twitch_id) AS username,
        total_points,
        redemption_count,
        last_redeemed_at::TEXT AS last_redeemed_at
      FROM channel_point_usage_stats
      WHERE streamer_id = p_streamer_id
      ORDER BY total_points DESC, redemption_count DESC, last_redeemed_at DESC
      LIMIT GREATEST(1, p_limit)
    ) ranked;
  ELSE
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
  END IF;

  RETURN jsonb_build_object(
    'total_points', v_total_points,
    'ranking', v_ranking
  );
END;
$$;

REVOKE ALL ON FUNCTION get_channel_point_usage_stats(UUID, TIMESTAMPTZ, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_channel_point_usage_stats(UUID, TIMESTAMPTZ, INTEGER) TO service_role;
