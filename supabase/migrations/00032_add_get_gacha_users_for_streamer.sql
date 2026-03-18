-- RPC: 配信者のガチャユーザー一覧をDB側で集約して返す
-- gacha_historyの件数制限（10,000件）を回避し、全ユーザーの正確なカード所有状況を返却する
-- user_cardsテーブルからアクティブカードのみを集約するため、
-- execute_gacha_transaction (00015) 導入前のデータでも正しく動作する
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
  -- 総ユニークユーザー数を取得（ページネーション用）
  SELECT COUNT(DISTINCT user_twitch_id) INTO v_total
  FROM gacha_history
  WHERE streamer_id = p_streamer_id;

  IF v_total = 0 THEN
    RETURN jsonb_build_object('users', '[]'::JSONB, 'total', 0);
  END IF;

  -- ユーザーごとの抽選回数・最終抽選日時を集約し、
  -- user_cardsからアクティブカードIDを取得して結合
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
    -- gacha_historyからユーザーごとの抽選統計を集約
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
  -- LEFT JOIN: user_cardsにレコードがないユーザー（旧データ）も含める
  LEFT JOIN LATERAL (
    SELECT COALESCE(jsonb_agg(DISTINCT uc.card_id), '[]'::JSONB) AS card_ids
    FROM user_cards uc
    JOIN users u ON u.id = uc.user_id
    JOIN cards c ON c.id = uc.card_id
    WHERE u.twitch_user_id = ud.user_twitch_id
      AND c.streamer_id = p_streamer_id
      AND c.is_active = true
  ) uc_agg ON true;

  RETURN v_result;
END;
$$;

-- service_role のみ実行可能（00031と同じ権限モデル）
REVOKE ALL ON FUNCTION get_gacha_users_for_streamer(UUID, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_gacha_users_for_streamer(UUID, INTEGER, INTEGER) TO service_role;

-- GROUP BY + COUNT(DISTINCT) のパフォーマンス確保用複合インデックス
-- 大量ガチャ履歴（10,000件超）環境でRPCがフルスキャンを回避するために必須
-- Note: CONCURRENTLY はトランザクション内で使用不可のため通常の CREATE INDEX を使用
-- 大規模テーブルでの本番適用時は手動で CREATE INDEX CONCURRENTLY を検討すること
CREATE INDEX IF NOT EXISTS idx_gacha_history_streamer_user
  ON gacha_history(streamer_id, user_twitch_id);
