-- Migration: Add batch_update_card_drop_rates RPC function
-- カードのdrop_rateを一括更新するRPC関数を追加
--
-- 目的:
-- - Cloudflare Workersのサブリクエスト上限（50回/リクエスト）を回避
-- - 従来は各カードごとに個別のUPDATEクエリを発行していたため、
--   カード数が多い場合にサブリクエスト上限を超過してエラーが発生していた
-- - この関数により、全カードの更新を1回のDB呼び出しで完了できる

-- batch_update_card_drop_rates: 複数カードのdrop_rateを一括更新
-- p_streamer_id: 更新対象カードの所有ストリーマーID（セキュリティのため必須）
-- p_updates: [{id: カードID, drop_rate: 新しいドロップレート}] のJSON配列
--
-- セキュリティ:
-- - streamer_idの一致を必ず検証し、他のストリーマーのカードは更新不可
-- - drop_rateの範囲チェック(0〜1)はテーブルのCHECK制約で担保
-- - REVOKE/GRANTで実行権限をservice_roleのみに限定（デフォルトではpublicが実行可能なため）
-- - SECURITY DEFINERは不要（service_roleは既にRLSをバイパスできる）
CREATE OR REPLACE FUNCTION batch_update_card_drop_rates(
  p_streamer_id UUID,
  p_updates JSONB
) RETURNS JSONB AS $$
DECLARE
  v_updated_count INT;
BEGIN
  -- JSONB配列の各要素を展開し、cardsテーブルをJOIN UPDATEで一括更新
  -- streamer_idの一致を必ず検証することで、他のストリーマーのカードへの不正更新を防止
  UPDATE cards
  SET
    drop_rate = (u.value->>'drop_rate')::DECIMAL(5,4),
    updated_at = NOW()
  FROM jsonb_array_elements(p_updates) AS u(value)
  WHERE cards.id = (u.value->>'id')::UUID
    AND cards.streamer_id = p_streamer_id;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  -- 更新件数を返却（呼び出し元で期待件数との照合に使用）
  RETURN jsonb_build_object('updated_count', v_updated_count);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION batch_update_card_drop_rates IS
  '複数カードのdrop_rateを1回のDB呼び出しで一括更新。Cloudflare Workersのサブリクエスト制限対策';

-- 実行権限をservice_roleのみに限定
-- デフォルトではpublicロールに EXECUTE が付与されるため、明示的に剥奪してservice_roleにのみ許可
-- これによりSupabase anon keyからの直接呼び出しを防止
REVOKE ALL ON FUNCTION batch_update_card_drop_rates(UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION batch_update_card_drop_rates(UUID, JSONB) TO service_role;
