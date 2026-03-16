-- RPC: ユーザーのカード所有数をDB側でGROUP BY集計して返す
-- PostgRESTの行数制限（デフォルト1000件）を根本的に回避し、
-- ユニークカード種類数のみ返却することでデータ転送量も削減する
-- p_streamer_id を指定すると特定配信者のカードのみに絞り込む
CREATE OR REPLACE FUNCTION get_user_card_counts(
  p_twitch_user_id TEXT,
  p_streamer_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_result JSONB;
BEGIN
  SELECT id INTO v_user_id
  FROM users
  WHERE twitch_user_id = p_twitch_user_id;

  IF v_user_id IS NULL THEN
    RETURN '[]'::JSONB;
  END IF;

  -- サブクエリでcard_idごとにCOUNTし、card/streamer詳細をJOIN
  -- 10000枚所持でも、ユニークカード数（数百程度）のみ返却される
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'count', sub.cnt,
      'card', to_jsonb(c.*),
      'streamer', to_jsonb(s.*)
    )
  ), '[]'::JSONB)
  INTO v_result
  FROM (
    SELECT card_id, COUNT(*)::INTEGER AS cnt
    FROM user_cards
    WHERE user_id = v_user_id
    GROUP BY card_id
  ) sub
  JOIN cards c ON c.id = sub.card_id
  JOIN streamers s ON s.id = c.streamer_id
  WHERE (p_streamer_id IS NULL OR c.streamer_id = p_streamer_id);

  RETURN v_result;
END;
$$;

-- service_role のみ実行可能
REVOKE ALL ON FUNCTION get_user_card_counts(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_user_card_counts(TEXT, UUID) TO service_role;
