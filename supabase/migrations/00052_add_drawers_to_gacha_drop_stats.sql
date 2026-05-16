-- get_gacha_drop_stats に「期間内にそのカードを引いたユーザー」を追加。
--
-- 旧来の統計ページは 7日/30日 タブにも全期間の「所持ユーザー」を表示して
-- いたが、期間統計の文脈では「その期間にそのカードを引いたユーザー」を
-- 見たいという要望のため、card_stats の各カードに drawers/drawer_count を
-- 付与する。所持(user_cards)ではなく排出履歴(gacha_history)を期間で集計する。
--
-- 所持ユーザーは別途「カード別」タブ（get_card_owner_stats, 00051）で
-- 全期間集計として表示するため、本RPCからは所持情報を返さない。
--
-- drawers はカードごとに p_limit_per_card 件で打ち切り、JSONB ペイロードが
-- 青天井に膨らむのを防ぐ。total_draws / card_stats のレート計算と
-- rarity_stats のロジックは 00050 から変更なし。

CREATE OR REPLACE FUNCTION get_gacha_drop_stats(
  p_streamer_id UUID,
  p_from_date TIMESTAMPTZ,
  p_limit_per_card INTEGER DEFAULT 100
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

  -- カードごとに gacha_history を引き直す N+1 な LATERAL を避け、
  -- 期間内の履歴を一度だけ (card_id, user_twitch_id) で集計し、
  -- ウィンドウ関数で「カード内の引いた回数ランキング」を付与する。
  -- これにより gacha_history へのアクセスはカード数に依らず一定回数。
  WITH draw_counts AS (
    SELECT card_id, COUNT(*)::BIGINT AS draw_count
    FROM gacha_history
    WHERE streamer_id = p_streamer_id
      AND redeemed_at >= p_from_date
    GROUP BY card_id
  ),
  drawer_agg AS (
    SELECT
      gh.card_id,
      gh.user_twitch_id,
      COALESCE(MAX(gh.user_twitch_username), gh.user_twitch_id) AS username,
      COUNT(*)::BIGINT AS draw_count,
      MAX(gh.redeemed_at) AS last_drawn_at
    FROM gacha_history gh
    WHERE gh.streamer_id = p_streamer_id
      AND gh.redeemed_at >= p_from_date
    GROUP BY gh.card_id, gh.user_twitch_id
  ),
  drawer_ranked AS (
    SELECT
      da.*,
      ROW_NUMBER() OVER (
        PARTITION BY da.card_id
        ORDER BY da.draw_count DESC, da.last_drawn_at DESC
      ) AS rn
    FROM drawer_agg da
  ),
  -- drawer_count はカード内の全ユニークユーザー数（打ち切り前）、
  -- drawers は rn <= p_limit_per_card のみを JSONB 化（上位N件）。
  drawer_by_card AS (
    SELECT
      dr.card_id,
      COUNT(*)::BIGINT AS drawer_count,
      jsonb_agg(
        jsonb_build_object(
          'user_twitch_id', dr.user_twitch_id,
          'username', dr.username,
          'draw_count', dr.draw_count,
          'last_drawn_at', dr.last_drawn_at
        )
        ORDER BY dr.draw_count DESC, dr.last_drawn_at DESC
      ) FILTER (WHERE dr.rn <= GREATEST(1, p_limit_per_card)) AS drawers
    FROM drawer_ranked dr
    GROUP BY dr.card_id
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
      END,
      'drawer_count', COALESCE(dbc.drawer_count, 0),
      'drawers', COALESCE(dbc.drawers, '[]'::JSONB)
    )
    ORDER BY c.rarity_order ASC, c.created_at DESC
  ), '[]'::JSONB)
  INTO v_card_stats
  FROM cards c
  LEFT JOIN draw_counts dc ON dc.card_id = c.id
  LEFT JOIN drawer_by_card dbc ON dbc.card_id = c.id
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
  default_order AS (
    SELECT *
    FROM (VALUES
      ('legendary'::TEXT, 1),
      ('epic'::TEXT, 2),
      ('rare'::TEXT, 3),
      ('common'::TEXT, 4)
    ) AS r(rarity, sort_order)
  ),
  -- デフォルト4種（排出0でも常に表示）＋ 実際に排出されたカスタムレアリティ。
  -- カスタムは sort_order=5 でデフォルトの後ろ、名前順で安定整列する。
  rarity_universe AS (
    SELECT rarity, sort_order FROM default_order
    UNION
    SELECT rc.rarity, 5
    FROM rarity_counts rc
    WHERE rc.rarity NOT IN (SELECT rarity FROM default_order)
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'rarity', ru.rarity,
      'count', COALESCE(rc.draw_count, 0),
      'rate', CASE
        WHEN v_total_draws > 0 THEN (COALESCE(rc.draw_count, 0)::NUMERIC / v_total_draws) * 100
        ELSE 0
      END
    )
    ORDER BY ru.sort_order, ru.rarity
  )
  INTO v_rarity_stats
  FROM rarity_universe ru
  LEFT JOIN rarity_counts rc ON rc.rarity = ru.rarity;

  RETURN jsonb_build_object(
    'total_draws', v_total_draws,
    'card_stats', v_card_stats,
    'rarity_stats', v_rarity_stats
  );
END;
$$;

-- 旧シグネチャ get_gacha_drop_stats(UUID, TIMESTAMPTZ) は本マイグレーションで
-- 追加した3引数版に置き換わる。デフォルト引数付きで定義したため2引数呼び出し
-- とも互換だが、PostgreSQL はデフォルト値の異なる同名関数を別関数として
-- 保持するため、曖昧さ回避のため旧2引数版を明示的に削除する。
DROP FUNCTION IF EXISTS get_gacha_drop_stats(UUID, TIMESTAMPTZ);

REVOKE ALL ON FUNCTION get_gacha_drop_stats(UUID, TIMESTAMPTZ, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_gacha_drop_stats(UUID, TIMESTAMPTZ, INTEGER) TO service_role;
