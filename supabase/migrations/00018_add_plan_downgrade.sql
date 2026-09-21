-- Migration: Add plan downgrade support
-- プランダウングレード機能を追加
--
-- 目的:
-- 1. activate_support_code を改修し、下位コード入力時に上位ライセンスを自動削除
-- 2. deactivate_all_licenses RPC を追加し、Basicへの復帰を可能にする

-- ========================================
-- activate_support_code RPC (改修)
-- ========================================
-- 変更点: ライセンスINSERT前に、新コードより上位のライセンスを DELETE
-- これにより下位コード入力時に自動ダウングレードが実現される
-- 例: support(優先度1)を入力 → patron(優先度2)のライセンスを削除
-- 同ティアまたは上位コード入力時はDELETE対象が0件（既存動作と同一）
CREATE OR REPLACE FUNCTION activate_support_code(
  p_code_hash TEXT,
  p_twitch_user_id TEXT,
  p_fanbox_id TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_code_record RECORD;
  v_license_id UUID;
  v_deactivated_count INTEGER;
  -- プラン優先度マッピング（高い値が上位プラン）
  -- 注意: 新プランタイプ追加時はこことsupport_codesのCHECK制約の両方を更新すること
  v_plan_priority JSONB := '{"support": 1, "patron": 2}'::JSONB;
  v_new_priority INTEGER;
BEGIN
  -- 1. コードを排他ロックで取得（レースコンディション防止）
  SELECT id, plan_type, status
    INTO v_code_record
    FROM support_codes
    WHERE code_hash = p_code_hash
    FOR UPDATE;

  -- コードが存在しない場合
  IF v_code_record IS NULL THEN
    RETURN jsonb_build_object('error', 'INVALID_CODE');
  END IF;

  -- コードが無効化済みの場合
  IF v_code_record.status = 'revoked' THEN
    RETURN jsonb_build_object('error', 'CODE_REVOKED');
  END IF;

  -- コードがrotating状態（新規アクティベーション不可）
  IF v_code_record.status = 'rotating' THEN
    RETURN jsonb_build_object('error', 'CODE_ROTATING');
  END IF;

  -- 2. 新コードの優先度を取得
  v_new_priority := (v_plan_priority ->> v_code_record.plan_type)::INTEGER;

  -- 3. 新コードより上位のライセンスを削除（ダウングレード処理）
  -- 有効なコード(active/rotating)に紐づくライセンスのみを対象とする
  DELETE FROM user_licenses ul
    USING support_codes sc
    WHERE ul.code_id = sc.id
      AND ul.twitch_user_id = p_twitch_user_id
      AND sc.status IN ('active', 'rotating')
      AND (v_plan_priority ->> ul.plan_type)::INTEGER > v_new_priority;
  GET DIAGNOSTICS v_deactivated_count = ROW_COUNT;

  -- 4. ライセンスを挿入（UNIQUE制約で重複を検知）
  INSERT INTO user_licenses (twitch_user_id, code_id, plan_type, fanbox_id)
  VALUES (p_twitch_user_id, v_code_record.id, v_code_record.plan_type, p_fanbox_id)
  ON CONFLICT (twitch_user_id, code_id) DO NOTHING
  RETURNING id INTO v_license_id;

  -- 重複アクティベーションの場合（ON CONFLICTでDO NOTHINGが実行された）
  IF v_license_id IS NULL THEN
    RETURN jsonb_build_object('error', 'ALREADY_ACTIVATED');
  END IF;

  -- 5. activation_count をインクリメント
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

-- ========================================
-- deactivate_all_licenses RPC (新規)
-- ========================================
-- 指定ユーザーの全ライセンスを削除し、Basicプランに復帰させる
-- 冪等性あり: ライセンスがない場合もエラーにならない
CREATE OR REPLACE FUNCTION deactivate_all_licenses(
  p_twitch_user_id TEXT
) RETURNS JSONB AS $$
DECLARE
  v_deleted_count INTEGER;
BEGIN
  DELETE FROM user_licenses
    WHERE twitch_user_id = p_twitch_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', true,
    'deleted_count', v_deleted_count
  );
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION deactivate_all_licenses IS
  'ユーザーの全ライセンスを削除してBasicプランに復帰させる。冪等性あり';

-- 実行権限をservice_roleのみに限定
REVOKE ALL ON FUNCTION deactivate_all_licenses(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION deactivate_all_licenses(TEXT) TO service_role;

-- activate_support_code の権限設定（00017で設定済みだがCREATE OR REPLACEで再定義したため防衛的に再設定）
REVOKE ALL ON FUNCTION activate_support_code(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION activate_support_code(TEXT, TEXT, TEXT) TO service_role;
