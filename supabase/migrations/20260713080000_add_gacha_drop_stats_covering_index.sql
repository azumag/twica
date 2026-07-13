-- Issue #672: get_gacha_drop_stats が gacha_history の期間集計中に
-- statement timeout を起こしたため、RPC 内の全スキャンで共通する
-- streamer_id / redeemed_at 条件と、その後の card_id / user_twitch_id
-- 集約を1本で支援する複合インデックスを追加する。
--
-- user_twitch_username は drawer_agg の MAX() で参照されるだけなので INCLUDE
-- とし、検索キーを肥大化させずに index-only scan の余地を残す。
-- Supabase migrations はトランザクション内で適用されるため CONCURRENTLY は
-- 使用しない。IF NOT EXISTS により再適用も安全にする。

CREATE INDEX IF NOT EXISTS idx_gacha_history_streamer_redeemed_card_user
  ON gacha_history(streamer_id, redeemed_at, card_id, user_twitch_id)
  INCLUDE (user_twitch_username);
