-- Migration: Add streamer_storage_bonus table
-- Purpose: ストリーマーごとにストレージ容量ボーナスを管理する汎用テーブル
-- キャンペーンやプロモーションで容量を付与するために使用
-- has-many: 1人のストリーマーに複数のボーナスエントリを持てる

CREATE TABLE IF NOT EXISTS streamer_storage_bonus (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- streamerテーブルへの外部キー（streamer削除時にcascade）
  streamer_id UUID NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  -- ボーナス容量（MB単位、正の整数のみ）
  amount_mb INTEGER NOT NULL CHECK (amount_mb > 0),
  -- ボーナスの種類（例: 'campaign', 'promotion', 'admin_grant'）
  type TEXT NOT NULL,
  -- 管理用メモ（どのキャンペーンか等を記録、UNIQUE制約のNULL問題を回避するためNOT NULL）
  memo TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  -- 同じstreamerに同じtype+memoの組み合わせは1回のみ（重複適用防止）
  UNIQUE (streamer_id, type, memo)
);

-- streamer_idでの検索用インデックス（ボーナス合計取得時に使用）
CREATE INDEX IF NOT EXISTS idx_streamer_storage_bonus_streamer_id
ON streamer_storage_bonus(streamer_id);

-- RLS有効化
ALTER TABLE streamer_storage_bonus ENABLE ROW LEVEL SECURITY;

-- service_roleはフルアクセス（サーバーサイド操作用）
DROP POLICY IF EXISTS "Service role can manage storage bonus" ON streamer_storage_bonus;
CREATE POLICY "Service role can manage storage bonus"
ON streamer_storage_bonus
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);
