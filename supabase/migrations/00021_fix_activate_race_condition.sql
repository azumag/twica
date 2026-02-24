-- Migration: activate_support_code のレースコンディション修正
--
-- 問題: DELETE→INSERT の順序で、同一コードでの再アクティベーション時に
-- 1. DELETE が上位ライセンスを削除（新コードと同ティアなら0件だが、上位なら削除される）
-- 2. INSERT が ON CONFLICT DO NOTHING でスキップ
-- 3. ALREADY_ACTIVATED を返すが、上位ライセンスは既に消失 → データ不整合
--
-- 修正: DELETE の前に同一コードの既存ライセンスをチェックし、
-- 存在すれば即座に ALREADY_ACTIVATED を返す（何も変更しない）
--
-- 修正前: コード検証 → DELETE上位 → INSERT(ON CONFLICT) → ALREADY_ACTIVATED判定
-- 修正後: コード検証 → 同一コード既存チェック(→ALREADY_ACTIVATED) → DELETE上位 → INSERT

CREATE OR REPLACE FUNCTION activate_support_code(
  p_code_hash TEXT,
  p_twitch_user_id TEXT,
  p_fanbox_id TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_code_record RECORD;
  v_license_id UUID;
  v_deactivated_count INTEGER;
  v_plan_priority JSONB := '{"support": 1, "patron": 2}'::JSONB;
  v_new_priority INTEGER;
BEGIN
  -- 1. コードを排他ロックで取得（レースコンディション防止）
  -- NOTE: SELECT INTO で行が見つからない場合、FOUND = false となる
  -- v_code_record IS NULL ではなく NOT FOUND を使用すること（PostgreSQL の RECORD 型仕様）
  SELECT id, plan_type, status
    INTO v_code_record
    FROM support_codes
    WHERE code_hash = p_code_hash
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'INVALID_CODE');
  END IF;

  IF v_code_record.status = 'revoked' THEN
    RETURN jsonb_build_object('error', 'CODE_REVOKED');
  END IF;

  IF v_code_record.status = 'rotating' THEN
    RETURN jsonb_build_object('error', 'CODE_ROTATING');
  END IF;

  -- 2. 同一コードの既存ライセンスをチェック（DELETE前に判定することでデータ消失を防止）
  -- このチェックにより、再アクティベーション時にDELETEが実行されることを防ぐ
  IF EXISTS (
    SELECT 1 FROM user_licenses
    WHERE twitch_user_id = p_twitch_user_id
      AND code_id = v_code_record.id
  ) THEN
    RETURN jsonb_build_object('error', 'ALREADY_ACTIVATED');
  END IF;

  -- 3. 新コードの優先度を取得
  v_new_priority := (v_plan_priority ->> v_code_record.plan_type)::INTEGER;

  -- 4. 新コードより上位のライセンスを削除（ダウングレード処理）
  -- 有効なコード(active/rotating)に紐づくライセンスのみを対象とする
  DELETE FROM user_licenses ul
    USING support_codes sc
    WHERE ul.code_id = sc.id
      AND ul.twitch_user_id = p_twitch_user_id
      AND sc.status IN ('active', 'rotating')
      AND (v_plan_priority ->> ul.plan_type)::INTEGER > v_new_priority;
  GET DIAGNOSTICS v_deactivated_count = ROW_COUNT;

  -- 5. ライセンスを挿入（UNIQUE制約で重複を検知、ステップ2で事前チェック済みだが防衛的に残す）
  INSERT INTO user_licenses (twitch_user_id, code_id, plan_type, fanbox_id)
  VALUES (p_twitch_user_id, v_code_record.id, v_code_record.plan_type, p_fanbox_id)
  ON CONFLICT (twitch_user_id, code_id) DO NOTHING
  RETURNING id INTO v_license_id;

  IF v_license_id IS NULL THEN
    -- ステップ2で事前チェックしているため、ここに到達するのは極めて稀な並行実行時のみ
    RETURN jsonb_build_object('error', 'ALREADY_ACTIVATED');
  END IF;

  -- 6. activation_count をインクリメント
  UPDATE support_codes
    SET activation_count = activation_count + 1,
        updated_at = NOW()
    WHERE id = v_code_record.id;

  RETURN jsonb_build_object(
    'success', true,
    'plan_type', v_code_record.plan_type,
    'license_id', v_license_id,
    'deactivated_count', v_deactivated_count
  );
END;
$$ LANGUAGE plpgsql;

-- 権限設定（CREATE OR REPLACE で再定義したため防衛的に再設定）
REVOKE ALL ON FUNCTION activate_support_code(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION activate_support_code(TEXT, TEXT, TEXT) TO service_role;
