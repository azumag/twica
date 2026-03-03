-- コレクションコンプリート達成記録テーブル
-- 配信者がカード追加しても過去のコンプリート達成が消えないよう、達成時点を永続化する
-- announcement_reads と同パターン（twitch_user_id TEXT, FKなし）
CREATE TABLE IF NOT EXISTS collection_completions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  twitch_user_id TEXT NOT NULL,
  streamer_id UUID NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  -- 達成時のアクティブカード総数。カード追加後の再コンプリートは別レコードになる
  total_cards INTEGER NOT NULL CHECK (total_cards > 0),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- 同一ユーザー・同一配信者・同一total_cardsでの重複防止
  UNIQUE (twitch_user_id, streamer_id, total_cards)
);

CREATE INDEX IF NOT EXISTS idx_collection_completions_user_streamer
ON collection_completions(twitch_user_id, streamer_id);

-- RLS: service_roleのみフルアクセス（サーバーサイド専用、00016踏襲）
ALTER TABLE collection_completions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can manage collection completions"
ON collection_completions
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);
