-- batch_update_card_drop_rates を拡張: intra_rarity_weight の更新もサポート
-- p_updates配列の各要素に intra_rarity_weight が含まれる場合のみ更新する
CREATE OR REPLACE FUNCTION batch_update_card_drop_rates(
  p_streamer_id UUID,
  p_updates JSONB
) RETURNS JSONB AS $$
DECLARE
  v_updated_count INT;
BEGIN
  -- JSONB配列の各要素を展開し、cardsテーブルをJOIN UPDATEで一括更新
  -- intra_rarity_weight は COALESCE で既存値をフォールバックに使い、未指定時は変更しない
  UPDATE cards
  SET
    drop_rate = (u.value->>'drop_rate')::DECIMAL(5,4),
    intra_rarity_weight = COALESCE(
      (u.value->>'intra_rarity_weight')::NUMERIC,
      cards.intra_rarity_weight
    ),
    updated_at = NOW()
  FROM jsonb_array_elements(p_updates) AS u(value)
  WHERE cards.id = (u.value->>'id')::UUID
    AND cards.streamer_id = p_streamer_id;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  RETURN jsonb_build_object('updated_count', v_updated_count);
END;
$$ LANGUAGE plpgsql;

-- 権限の再設定（CREATE OR REPLACEでは権限は保持されるが明示的に）
REVOKE ALL ON FUNCTION batch_update_card_drop_rates(UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION batch_update_card_drop_rates(UUID, JSONB) TO service_role;
