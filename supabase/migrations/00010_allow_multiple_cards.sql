-- Migration: Allow multiple copies of the same card per user
-- This removes the UNIQUE constraint that was incorrectly added in commit aa1ce49
-- Users should be able to collect multiple copies of the same card
--
-- マイグレーション: ユーザーが同じカードを複数枚所持できるようにする
-- コミットaa1ce49で誤って追加されたUNIQUE制約を削除
-- ユーザーは同じカードを複数枚コレクションできるべき

ALTER TABLE user_cards DROP CONSTRAINT IF EXISTS user_cards_user_id_card_id_key;
