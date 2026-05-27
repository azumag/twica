-- Refresh get_gacha_users_for_streamer so user progress counts unique owned card types.
-- Existing environments already applied 00032, so this replacement migration forces
-- production to pick up the DISTINCT user_cards aggregation on the next deploy.
CREATE OR REPLACE FUNCTION get_gacha_users_for_streamer(
  p_streamer_id UUID,
  p_limit INTEGER DEFAULT 20,
  p_offset INTEGER DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
  v_total INTEGER;
BEGIN
  SELECT COUNT(DISTINCT user_twitch_id) INTO v_total
  FROM gacha_history
  WHERE streamer_id = p_streamer_id;

  IF v_total = 0 THEN
    RETURN jsonb_build_object('users', '[]'::JSONB, 'total', 0);
  END IF;

  SELECT jsonb_build_object(
    'users', COALESCE(jsonb_agg(
      jsonb_build_object(
        'user_twitch_id', ud.user_twitch_id,
        'username', ud.username,
        'draw_count', ud.draw_count,
        'last_draw_at', ud.last_draw_at,
        'unique_card_ids', COALESCE(uc_agg.card_ids, '[]'::JSONB)
      )
      ORDER BY ud.draw_count DESC
    ), '[]'::JSONB),
    'total', v_total
  )
  INTO v_result
  FROM (
    SELECT
      gh.user_twitch_id,
      MAX(gh.user_twitch_username) AS username,
      COUNT(*)::INTEGER AS draw_count,
      MAX(gh.redeemed_at)::TEXT AS last_draw_at
    FROM gacha_history gh
    WHERE gh.streamer_id = p_streamer_id
    GROUP BY gh.user_twitch_id
    ORDER BY draw_count DESC
    LIMIT p_limit OFFSET p_offset
  ) ud
  LEFT JOIN LATERAL (
    SELECT COALESCE(jsonb_agg(card_id ORDER BY card_id), '[]'::JSONB) AS card_ids
    FROM (
      SELECT DISTINCT uc.card_id::TEXT AS card_id
      FROM user_cards uc
      JOIN users u ON u.id = uc.user_id
      JOIN cards c ON c.id = uc.card_id
      WHERE u.twitch_user_id = ud.user_twitch_id
        AND c.streamer_id = p_streamer_id
        AND c.is_active = true
    ) unique_cards
  ) uc_agg ON true;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION get_gacha_users_for_streamer(UUID, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_gacha_users_for_streamer(UUID, INTEGER, INTEGER) TO service_role;
