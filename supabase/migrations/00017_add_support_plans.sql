-- Migration: Add support plan system
-- 支援プランシステムのテーブル・RPC関数を追加
--
-- 目的:
-- - FANBOXやTwitchサブスク等の支援者にストレージ容量増加等の特典を提供
-- - 共有コードをSHA-256ハッシュ化して保存し、平文は保存しない
-- - ライセンスに有効期限は設けない（コードが有効な限りライセンスも有効）

-- ========================================
-- support_codes テーブル（共有コードマスタ）
-- ========================================
-- コードはSHA-256ハッシュとして保存（平文は管理画面生成時に一度だけ表示）
-- status: 'active'=通常利用可, 'rotating'=既存ユーザーは有効だが新規アクティベーション不可, 'revoked'=無効化済み
CREATE TABLE support_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash TEXT NOT NULL UNIQUE,
  plan_type TEXT NOT NULL CHECK (plan_type IN ('support', 'patron')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'rotating', 'revoked')),
  memo TEXT DEFAULT '',
  activation_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- インデックス: コードハッシュでの検索を高速化
CREATE INDEX idx_support_codes_code_hash ON support_codes (code_hash);
-- インデックス: ステータスでのフィルタリング
CREATE INDEX idx_support_codes_status ON support_codes (status);

COMMENT ON TABLE support_codes IS '支援プランの共有コードマスタ。コードはSHA-256ハッシュで保存';
COMMENT ON COLUMN support_codes.code_hash IS 'SHA-256ハッシュ化されたコード';
COMMENT ON COLUMN support_codes.plan_type IS 'プランタイプ: support(500MB) or patron(1GB)';
COMMENT ON COLUMN support_codes.status IS 'active=利用可, rotating=新規不可, revoked=無効化';

-- ========================================
-- user_licenses テーブル（ユーザーのライセンス）
-- ========================================
-- twitch_user_idとcode_idの組み合わせで一意（同一コードを同一ユーザーが複数回使えない）
CREATE TABLE user_licenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  twitch_user_id TEXT NOT NULL,
  code_id UUID NOT NULL REFERENCES support_codes(id) ON DELETE CASCADE,
  plan_type TEXT NOT NULL CHECK (plan_type IN ('support', 'patron')),
  fanbox_id TEXT DEFAULT NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (twitch_user_id, code_id)
);

-- インデックス: ユーザーIDでの検索（プラン判定時に使用）
CREATE INDEX idx_user_licenses_twitch_user_id ON user_licenses (twitch_user_id);
-- インデックス: コードIDでの逆引き（コード無効化時に使用）
CREATE INDEX idx_user_licenses_code_id ON user_licenses (code_id);

COMMENT ON TABLE user_licenses IS 'ユーザーの支援プランライセンス。コードが有効な限りライセンスも有効';
COMMENT ON COLUMN user_licenses.fanbox_id IS 'FANBOX IDの参考情報（不正検知用）';

-- ========================================
-- RLS（Row Level Security）
-- ========================================
ALTER TABLE support_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_licenses ENABLE ROW LEVEL SECURITY;

-- service_role のみアクセス可（API Route からのみ操作）
-- anon/authenticated ユーザーは直接テーブルにアクセスできない
CREATE POLICY "service_role_support_codes" ON support_codes
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "service_role_user_licenses" ON user_licenses
  FOR ALL USING (auth.role() = 'service_role');

-- ========================================
-- activate_support_code RPC
-- ========================================
-- サポートコードのアクティベーションをアトミックに実行
-- レースコンディション防止のため FOR UPDATE で排他ロック
CREATE OR REPLACE FUNCTION activate_support_code(
  p_code_hash TEXT,
  p_twitch_user_id TEXT,
  p_fanbox_id TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_code_record RECORD;
  v_license_id UUID;
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

  -- 2. ライセンスを挿入（UNIQUE制約で重複を検知）
  INSERT INTO user_licenses (twitch_user_id, code_id, plan_type, fanbox_id)
  VALUES (p_twitch_user_id, v_code_record.id, v_code_record.plan_type, p_fanbox_id)
  ON CONFLICT (twitch_user_id, code_id) DO NOTHING
  RETURNING id INTO v_license_id;

  -- 重複アクティベーションの場合（ON CONFLICTでDO NOTHINGが実行された）
  IF v_license_id IS NULL THEN
    RETURN jsonb_build_object('error', 'ALREADY_ACTIVATED');
  END IF;

  -- 3. activation_count をインクリメント
  UPDATE support_codes
    SET activation_count = activation_count + 1,
        updated_at = NOW()
    WHERE id = v_code_record.id;

  RETURN jsonb_build_object(
    'success', true,
    'plan_type', v_code_record.plan_type,
    'license_id', v_license_id
  );
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION activate_support_code IS
  'サポートコードをアクティベートし、ユーザーにライセンスを付与する。排他ロックでレースコンディションを防止';

-- 実行権限をservice_roleのみに限定
REVOKE ALL ON FUNCTION activate_support_code(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION activate_support_code(TEXT, TEXT, TEXT) TO service_role;

-- ========================================
-- revoke_support_code RPC
-- ========================================
-- コードを無効化し、関連ライセンスを削除
CREATE OR REPLACE FUNCTION revoke_support_code(
  p_code_id UUID
) RETURNS JSONB AS $$
DECLARE
  v_deleted_count INTEGER;
BEGIN
  -- 1. コードステータスを revoked に更新
  UPDATE support_codes
    SET status = 'revoked',
        updated_at = NOW()
    WHERE id = p_code_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'CODE_NOT_FOUND');
  END IF;

  -- 2. 関連ライセンスを削除（CASCADE設定済みだが明示的に削除してカウントを取得）
  DELETE FROM user_licenses WHERE code_id = p_code_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', true,
    'deleted_licenses', v_deleted_count
  );
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION revoke_support_code IS
  'サポートコードを無効化し、関連する全ライセンスを削除する';

REVOKE ALL ON FUNCTION revoke_support_code(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_support_code(UUID) TO service_role;
