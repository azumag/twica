-- Migration: Add Storage Tracking Tables
-- ストレージ使用量追跡用のテーブルを追加
--
-- 目的:
-- - Vercel Blobの list() 操作を廃止し、操作数制限（2,000/月）を節約
-- - ユーザーごと・グローバルのストレージ使用量をDBで管理
-- - R2とVercel Blobの両方をサポート

-- ストレージ使用量テーブル
-- ユーザーごとおよびグローバルのストレージ使用量を管理
CREATE TABLE IF NOT EXISTS storage_usage (
  user_prefix VARCHAR(8) PRIMARY KEY,
  bytes_used BIGINT NOT NULL DEFAULT 0,
  blob_count INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- コメント追加
COMMENT ON TABLE storage_usage IS 'ユーザーごとおよびグローバルのストレージ使用量を管理';
COMMENT ON COLUMN storage_usage.user_prefix IS 'ユーザー識別用プレフィックス（8文字ハッシュ）。_global_ はグローバル合計';
COMMENT ON COLUMN storage_usage.bytes_used IS '使用バイト数';
COMMENT ON COLUMN storage_usage.blob_count IS 'ファイル数';
COMMENT ON COLUMN storage_usage.updated_at IS '最終更新日時';

-- グローバル使用量用レコードを初期挿入
-- _global_ はグローバル合計を表す特殊なプレフィックス
INSERT INTO storage_usage (user_prefix, bytes_used, blob_count)
VALUES ('_global_', 0, 0)
ON CONFLICT (user_prefix) DO NOTHING;

-- 個別ファイル情報テーブル
-- 削除時にサイズを取得するため、各ファイルの情報を記録
CREATE TABLE IF NOT EXISTS blob_files (
  url TEXT PRIMARY KEY,
  user_prefix VARCHAR(8) NOT NULL,
  file_size BIGINT NOT NULL,
  storage_type VARCHAR(10) NOT NULL DEFAULT 'r2',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT valid_storage_type CHECK (storage_type IN ('r2', 'vercel'))
);

-- インデックス追加（user_prefixでの検索を高速化）
CREATE INDEX IF NOT EXISTS idx_blob_files_user_prefix ON blob_files(user_prefix);

-- コメント追加
COMMENT ON TABLE blob_files IS '個別ファイル情報（削除時にサイズを取得するため）';
COMMENT ON COLUMN blob_files.url IS 'ファイルの公開URL（主キー）';
COMMENT ON COLUMN blob_files.user_prefix IS 'ファイル所有者のユーザープレフィックス';
COMMENT ON COLUMN blob_files.file_size IS 'ファイルサイズ（バイト）';
COMMENT ON COLUMN blob_files.storage_type IS 'ストレージの種類: r2 または vercel';
COMMENT ON COLUMN blob_files.created_at IS 'ファイル作成日時';

-- ストレージ使用量更新用の関数
-- アップロード時・削除時に呼び出して使用量を更新
CREATE OR REPLACE FUNCTION update_storage_usage(
  p_user_prefix VARCHAR(8),
  p_size_delta BIGINT,
  p_count_delta INT
) RETURNS void AS $$
BEGIN
  -- ユーザーの使用量を更新（存在しなければ挿入）
  INSERT INTO storage_usage (user_prefix, bytes_used, blob_count, updated_at)
  VALUES (p_user_prefix, GREATEST(0, p_size_delta), GREATEST(0, p_count_delta), NOW())
  ON CONFLICT (user_prefix) DO UPDATE SET
    bytes_used = GREATEST(0, storage_usage.bytes_used + p_size_delta),
    blob_count = GREATEST(0, storage_usage.blob_count + p_count_delta),
    updated_at = NOW();

  -- グローバル使用量を更新
  UPDATE storage_usage SET
    bytes_used = GREATEST(0, bytes_used + p_size_delta),
    blob_count = GREATEST(0, blob_count + p_count_delta),
    updated_at = NOW()
  WHERE user_prefix = '_global_';
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION update_storage_usage IS 'ストレージ使用量を更新（ユーザーとグローバル両方）';

-- RLS (Row Level Security) ポリシーの設定
-- blob_files と storage_usage はサービスロールキーでのみアクセス可能
-- フロントエンドからは直接アクセスさせない（APIを経由する）
ALTER TABLE storage_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE blob_files ENABLE ROW LEVEL SECURITY;

-- サービスロールは全ての操作が可能
CREATE POLICY service_role_storage_usage ON storage_usage
  FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role')
  WITH CHECK (auth.jwt() ->> 'role' = 'service_role');

CREATE POLICY service_role_blob_files ON blob_files
  FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role')
  WITH CHECK (auth.jwt() ->> 'role' = 'service_role');
