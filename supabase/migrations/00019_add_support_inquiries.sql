-- Migration: Add support inquiries system
-- 支援者限定の問い合わせ機能テーブルを追加
-- 支援者がバグ報告・機能要望・その他の問い合わせを投稿し、管理者が返信できる双方向の仕組み

-- support_inquiries: 問い合わせ本体テーブル
CREATE TABLE IF NOT EXISTS support_inquiries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- 投稿者のTwitchユーザーID（usersテーブル未登録でも投稿可能にするためFKなし）
  twitch_user_id TEXT NOT NULL,
  -- 投稿時点の表示名スナップショット（表示名変更に影響されないよう保存）
  twitch_display_name TEXT NOT NULL,
  -- カテゴリ: bug=バグ報告, feature=機能要望, other=その他
  category TEXT NOT NULL CHECK (category IN ('bug', 'feature', 'other')),
  -- 件名（最大200文字）
  subject TEXT NOT NULL CHECK (char_length(subject) <= 200),
  -- 初回投稿本文（最大2000文字）
  body TEXT NOT NULL CHECK (char_length(body) <= 2000),
  -- ステータス: open=未対応, in_progress=対応中, resolved=解決済, closed=クローズ
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- support_inquiry_messages: 後続メッセージ（ユーザー/管理者の返信）
CREATE TABLE IF NOT EXISTS support_inquiry_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- 親の問い合わせ（削除時にメッセージも連鎖削除）
  inquiry_id UUID NOT NULL REFERENCES support_inquiries(id) ON DELETE CASCADE,
  -- 送信者タイプ: user=ユーザー, admin=管理者
  sender_type TEXT NOT NULL CHECK (sender_type IN ('user', 'admin')),
  -- 送信者ID（user: twitchUserId, admin: 'admin'）
  sender_id TEXT NOT NULL,
  -- メッセージ本文（最大2000文字）
  body TEXT NOT NULL CHECK (char_length(body) <= 2000),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- updated_atの自動更新トリガー（00001_initial_schemaで定義済みの関数を再利用）
DROP TRIGGER IF EXISTS update_support_inquiries_updated_at ON support_inquiries;
CREATE TRIGGER update_support_inquiries_updated_at
  BEFORE UPDATE ON support_inquiries
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- インデックス: ユーザーごとの問い合わせ取得用
CREATE INDEX IF NOT EXISTS idx_support_inquiries_twitch_user_id
ON support_inquiries(twitch_user_id);

-- インデックス: ステータスフィルタ用
CREATE INDEX IF NOT EXISTS idx_support_inquiries_status
ON support_inquiries(status);

-- インデックス: 一覧表示の作成日時ソート用
CREATE INDEX IF NOT EXISTS idx_support_inquiries_created_at_desc
ON support_inquiries(created_at DESC);

-- インデックス: メッセージの時系列取得用（inquiry_idで絞り込み + 作成日時でソート）
CREATE INDEX IF NOT EXISTS idx_support_inquiry_messages_inquiry_created
ON support_inquiry_messages(inquiry_id, created_at ASC);

-- RLS: service_roleのみフルアクセス（サーバーサイド専用、既存パターン踏襲）
ALTER TABLE support_inquiries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role can manage support inquiries" ON support_inquiries;
CREATE POLICY "Service role can manage support inquiries"
ON support_inquiries
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

ALTER TABLE support_inquiry_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role can manage support inquiry messages" ON support_inquiry_messages;
CREATE POLICY "Service role can manage support inquiry messages"
ON support_inquiry_messages
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);
