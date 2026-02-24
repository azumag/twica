-- Migration: discord_user_id に UNIQUE パーシャルインデックスを追加
--
-- 問題: 00020_add_discord_linking.sql では通常 INDEX のみ作成しており、
-- 同一 Discord アカウントを複数 Twitch アカウントにリンク可能だった。
-- これによりサブスク特典の二重取得が可能になるリスクがあった。
--
-- 修正: 既存インデックスを削除し、UNIQUE パーシャルインデックスに置換する。
-- NULL は UNIQUE 制約の対象外なので、未連携ユーザー（discord_user_id = NULL）には影響しない。
--
-- 適用ノート:
--   CREATE INDEX CONCURRENTLY はトランザクション内で使用できないため、
--   Supabase マイグレーション（自動トランザクション）では使用不可。
--   users テーブルへの短時間のテーブルロックが発生するため、
--   低トラフィック時間帯（メンテナンスウィンドウ）での適用を推奨する。

-- 既存の非 UNIQUE インデックスを削除
DROP INDEX IF EXISTS idx_users_discord_user_id;

-- 既存データに重複があればマイグレーション失敗を防ぐため、重複行の古い方を NULL に更新
-- 最も新しい discord_token_expires_at を持つ行を正規とし、それ以外を解除する
UPDATE users SET
  discord_user_id = NULL,
  discord_access_token = NULL,
  discord_refresh_token = NULL,
  discord_token_expires_at = NULL,
  discord_sub_verified_at = NULL,
  discord_has_sub_role = false
WHERE discord_user_id IS NOT NULL
  AND twitch_user_id NOT IN (
    SELECT DISTINCT ON (discord_user_id) twitch_user_id
    FROM users
    WHERE discord_user_id IS NOT NULL
    ORDER BY discord_user_id, discord_token_expires_at DESC NULLS LAST
  );

-- UNIQUE パーシャルインデックスを作成
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_discord_user_id
  ON users (discord_user_id)
  WHERE discord_user_id IS NOT NULL;
