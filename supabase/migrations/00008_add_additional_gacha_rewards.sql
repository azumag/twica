-- Additional Gacha Rewards Table
-- 追加ガチャ報酬テーブル
--
-- This table stores additional channel point rewards that can trigger gacha.
-- The main reward is still stored in streamers.channel_point_reward_id for backward compatibility.
-- If no records exist in this table for a streamer, only the main reward triggers gacha.
-- If records exist, both the main reward AND additional rewards trigger gacha.
--
-- このテーブルはガチャをトリガーできる追加のチャンネルポイント報酬を保存します。
-- 後方互換性のため、メインの報酬は引き続き streamers.channel_point_reward_id に保存されます。
-- このテーブルにストリーマーのレコードがない場合、メインの報酬のみがガチャをトリガーします。
-- レコードがある場合、メインの報酬と追加報酬の両方がガチャをトリガーします。

CREATE TABLE streamer_additional_gacha_rewards (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  streamer_id UUID NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  reward_id TEXT NOT NULL,
  reward_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  -- Ensure each reward_id is unique per streamer
  -- ストリーマーごとに報酬IDが一意であることを保証
  UNIQUE (streamer_id, reward_id)
);

-- Index for faster lookup by streamer_id
-- streamer_idでの高速検索用インデックス
CREATE INDEX idx_additional_gacha_rewards_streamer_id ON streamer_additional_gacha_rewards(streamer_id);

-- Index for faster lookup by reward_id (used when verifying incoming EventSub events)
-- reward_idでの高速検索用インデックス（EventSubイベント検証時に使用）
CREATE INDEX idx_additional_gacha_rewards_reward_id ON streamer_additional_gacha_rewards(reward_id);

-- RLS
ALTER TABLE streamer_additional_gacha_rewards ENABLE ROW LEVEL SECURITY;

-- Service role can manage additional rewards
-- サービスロールは追加報酬を管理可能
CREATE POLICY "Service can manage additional gacha rewards" ON streamer_additional_gacha_rewards
  FOR ALL USING (true);

-- Public read access for active streamers' rewards (needed for UI)
-- アクティブなストリーマーの報酬への公開読み取りアクセス（UI用）
CREATE POLICY "Additional rewards are viewable for active streamers" ON streamer_additional_gacha_rewards
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM streamers
      WHERE streamers.id = streamer_additional_gacha_rewards.streamer_id
      AND streamers.is_active = true
    )
  );
