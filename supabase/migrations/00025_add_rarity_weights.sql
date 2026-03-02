-- Migration: Add rarity_weights JSONB column for auto drop-rate calculation by rarity
-- レアリティ別の自動ドロップ率計算用に rarity_weights JSONB カラムを追加
--
-- 設計方針:
-- - キーは固定せず任意のレアリティ名を許容（将来拡張に対応）
-- - 値のみ 0-100 の数値制約をDBで担保
-- - 必須キーの有無はアプリケーション側で検証

ALTER TABLE streamers
ADD COLUMN rarity_weights JSONB DEFAULT NULL;

-- Validate that rarity_weights is either NULL or:
-- 1) JSON object
-- 2) all values are numbers
-- 3) each value is within [0, 100]
CREATE OR REPLACE FUNCTION check_rarity_weights_values(weights JSONB)
RETURNS BOOLEAN AS $$
DECLARE
  key TEXT;
  val NUMERIC;
BEGIN
  IF weights IS NULL THEN
    RETURN TRUE;
  END IF;

  IF jsonb_typeof(weights) <> 'object' THEN
    RETURN FALSE;
  END IF;

  FOR key IN SELECT jsonb_object_keys(weights) LOOP
    IF jsonb_typeof(weights->key) <> 'number' THEN
      RETURN FALSE;
    END IF;

    val := (weights->>key)::NUMERIC;
    IF val < 0 OR val > 100 THEN
      RETURN FALSE;
    END IF;
  END LOOP;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

ALTER TABLE streamers
ADD CONSTRAINT rarity_weights_valid
CHECK (check_rarity_weights_values(rarity_weights));
