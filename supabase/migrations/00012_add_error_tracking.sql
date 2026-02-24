-- Migration: Add Error Tracking for GitHub Issue Automation
-- GitHub Issue自動作成のためのエラー追跡テーブル
--
-- メインWorker (twica) でキャッチしたエラーを記録し、
-- Cron Worker (twica-error-reporter) が定期的に読み出して
-- GitHub Issue を自動作成する。
--
-- See: https://github.com/azumag/twica/issues/239

-- エラーログテーブル
-- Tail Workers (有料) の代替として、Supabase をエラーストアとして使用
CREATE TABLE IF NOT EXISTS errors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- エラー種別: '[Error]', '[API Error]', '[Auth Error]', '[Gacha Error]' 等
  -- src/lib/sentry/error-handler.ts の各 report*Error() に対応
  error_type VARCHAR(50) NOT NULL,
  -- エラーメッセージ (最大10KB、error-handler.ts側でtruncate)
  message TEXT NOT NULL,
  -- スタックトレース (Error型の場合のみ、最大50KB)
  stack_trace TEXT,
  -- エラーコンテキスト (各 report*Error() の引数から取得)
  -- 例: { "endpoint": "/api/cards", "method": "POST", "userId": "..." }
  context JSONB DEFAULT '{}',
  -- 実行環境: 'production' or 'preview'
  -- NEXT_PUBLIC_APP_URL から自動判定
  environment VARCHAR(20) DEFAULT 'production',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  -- Cron Worker による GitHub Issue 作成状況
  github_issue_created BOOLEAN DEFAULT FALSE,
  github_issue_number INTEGER,
  github_issue_url TEXT
);

-- 未処理エラーの検索を高速化（Cron Worker が毎5分クエリする対象）
-- 部分インデックスで github_issue_created = FALSE のみ対象にし、サイズを最小化
CREATE INDEX IF NOT EXISTS idx_errors_pending ON errors(github_issue_created, created_at DESC)
  WHERE github_issue_created = FALSE;

-- エラーの長期保存データ削減のため、古いレコードを定期削除する際に使用
CREATE INDEX IF NOT EXISTS idx_errors_created_at ON errors(created_at);

COMMENT ON TABLE errors IS 'エラーログ（GitHub Issue自動作成用）- Issue #239';
COMMENT ON COLUMN errors.error_type IS 'エラー種別: [Error], [API Error], [Auth Error] 等';
COMMENT ON COLUMN errors.context IS 'エラーコンテキスト（JSON形式、機密情報を含めないこと）';

-- RLS: service_role のみアクセス可能
-- メインWorker・Cron Worker ともに SUPABASE_SERVICE_ROLE_KEY を使用
ALTER TABLE errors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_errors ON errors;
CREATE POLICY service_role_errors ON errors
  FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role')
  WITH CHECK (auth.jwt() ->> 'role' = 'service_role');
