-- Migration: Add announcements system
-- お知らせ機能のテーブルを追加
-- 管理者がお知らせを投稿し、ユーザーごとに既読/未読を管理する

-- announcements: お知らせ本体テーブル
CREATE TABLE IF NOT EXISTS announcements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  -- severity: 重要度レベル (info=通常, warning=注意, critical=重要)
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  -- is_published: 公開状態フラグ（falseの場合、ユーザーには表示されない）
  is_published BOOLEAN NOT NULL DEFAULT false,
  -- published_at: 公開開始日時（NULLの場合、is_published=trueなら即時公開）
  published_at TIMESTAMPTZ,
  -- expires_at: 公開終了日時（NULLの場合、無期限）
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- announcement_reads: ユーザーごとの既読管理テーブル
CREATE TABLE IF NOT EXISTS announcement_reads (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  announcement_id UUID NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  -- usersテーブルに未登録のユーザーも既読にできるようFKなし
  twitch_user_id TEXT NOT NULL,
  read_at TIMESTAMPTZ DEFAULT NOW(),
  -- 同一ユーザーが同じお知らせを複数回既読にすることを防止
  UNIQUE (announcement_id, twitch_user_id)
);

-- updated_atの自動更新トリガー（00001_initial_schemaで定義済みの関数を再利用）
DROP TRIGGER IF EXISTS update_announcements_updated_at ON announcements;
CREATE TRIGGER update_announcements_updated_at
  BEFORE UPDATE ON announcements
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- インデックス: 未読お知らせ取得時のパフォーマンス向上
CREATE INDEX IF NOT EXISTS idx_announcement_reads_twitch_user_id
ON announcement_reads(twitch_user_id);

CREATE INDEX IF NOT EXISTS idx_announcement_reads_announcement_id
ON announcement_reads(announcement_id);

-- RLS: service_roleのみフルアクセス（サーバーサイド専用、既存パターン00013踏襲）
ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role can manage announcements" ON announcements;
CREATE POLICY "Service role can manage announcements"
ON announcements
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

ALTER TABLE announcement_reads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role can manage announcement reads" ON announcement_reads;
CREATE POLICY "Service role can manage announcement reads"
ON announcement_reads
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);
