-- get_gacha_drop_stats の rarity_stats がカスタムレアリティを欠落させる不具合を修正。
--
-- 旧実装(00038)は固定4レアリティの VALUES を FROM 起点に LEFT JOIN していたため、
-- カスタムレアリティ(streamers.custom_rarities 由来等)のカードが排出されても
-- rarity_stats に一切現れず、内訳合計が total_draws と一致しなかった。
--
-- 本実装はデフォルト4種に加え、実際に排出されたカスタムレアリティも統合
-- (rarity_universe)して集計する。並び順はデフォルト4種を従来通り先頭に固定し、
-- カスタムは sort_order=5 でその後ろ、レアリティ名昇順で安定表示する。
-- card_stats / total_draws のロジックは 00038 から変更なし。

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

REVOKE ALL ON FUNCTION get_gacha_drop_stats(UUID, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_gacha_drop_stats(UUID, TIMESTAMPTZ) TO service_role;
