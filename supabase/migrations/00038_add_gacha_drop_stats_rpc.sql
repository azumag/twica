-- RPC: 配信者の期間内ガチャ排出統計をDB側で正確に集約して返す
-- PostgREST/Supabase client の行取得上限に左右されないよう、履歴行を
-- アプリに返さず、DB内で COUNT/GROUP BY した結果だけを返却する。
CREATE OR REPLACE FUNCTION get_gacha_drop_stats(
  p_streamer_id UUID,
  p_from_date TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_draws BIGINT;
  v_total_weight NUMERIC;
  v_card_stats JSONB;
  v_rarity_stats JSONB;
BEGIN
  SELECT COUNT(*)::BIGINT
  INTO v_total_draws
  FROM gacha_history
  WHERE streamer_id = p_streamer_id
    AND redeemed_at >= p_from_date;

  SELECT COALESCE(SUM(drop_rate), 0)::NUMERIC
  INTO v_total_weight
  FROM cards
  WHERE streamer_id = p_streamer_id
    AND is_active = TRUE;

  WITH draw_counts AS (
    SELECT card_id, COUNT(*)::BIGINT AS draw_count
    FROM gacha_history
    WHERE streamer_id = p_streamer_id
      AND redeemed_at >= p_from_date
    GROUP BY card_id
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'card_id', c.id,
      'card_name', c.name,
      'rarity', c.rarity,
      'image_url', c.image_url,
      'configured_rate', CASE
        WHEN v_total_weight > 0 THEN (c.drop_rate / v_total_weight) * 100
        ELSE 0
      END,
      'actual_count', COALESCE(dc.draw_count, 0),
      'actual_rate', CASE
        WHEN v_total_draws > 0 THEN (COALESCE(dc.draw_count, 0)::NUMERIC / v_total_draws) * 100
        ELSE 0
      END
    )
    ORDER BY c.rarity_order ASC, c.created_at DESC
  ), '[]'::JSONB)
  INTO v_card_stats
  FROM cards c
  LEFT JOIN draw_counts dc ON dc.card_id = c.id
  WHERE c.streamer_id = p_streamer_id
    AND c.is_active = TRUE;

  WITH rarity_counts AS (
    SELECT c.rarity, COUNT(*)::BIGINT AS draw_count
    FROM gacha_history gh
    JOIN cards c ON c.id = gh.card_id
    WHERE gh.streamer_id = p_streamer_id
      AND gh.redeemed_at >= p_from_date
    GROUP BY c.rarity
  ),
  rarity_order AS (
    SELECT *
    FROM (VALUES
      ('legendary'::TEXT, 1),
      ('epic'::TEXT, 2),
      ('rare'::TEXT, 3),
      ('common'::TEXT, 4)
    ) AS r(rarity, sort_order)
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'rarity', ro.rarity,
      'count', COALESCE(rc.draw_count, 0),
      'rate', CASE
        WHEN v_total_draws > 0 THEN (COALESCE(rc.draw_count, 0)::NUMERIC / v_total_draws) * 100
        ELSE 0
      END
    )
    ORDER BY ro.sort_order
  )
  INTO v_rarity_stats
  FROM rarity_order ro
  LEFT JOIN rarity_counts rc ON rc.rarity = ro.rarity;

  RETURN jsonb_build_object(
    'total_draws', v_total_draws,
    'card_stats', v_card_stats,
    'rarity_stats', v_rarity_stats
  );
END;
$$;

REVOKE ALL ON FUNCTION get_gacha_drop_stats(UUID, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_gacha_drop_stats(UUID, TIMESTAMPTZ) TO service_role;

CREATE INDEX IF NOT EXISTS idx_gacha_history_streamer_redeemed_card
  ON gacha_history(streamer_id, redeemed_at DESC, card_id);
