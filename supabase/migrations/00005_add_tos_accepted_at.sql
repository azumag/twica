-- Add tos_accepted_at column to users table
-- 利用規約同意日時カラムをusersテーブルに追加
-- This column tracks when the user accepted the Terms of Service
-- このカラムはユーザーが利用規約に同意した日時を記録します

ALTER TABLE users ADD COLUMN tos_accepted_at TIMESTAMPTZ DEFAULT NULL;

-- Create index for efficient querying of users who haven't accepted TOS
-- 利用規約未同意ユーザーの効率的なクエリのためのインデックスを作成
CREATE INDEX idx_users_tos_accepted_at ON users(tos_accepted_at);

COMMENT ON COLUMN users.tos_accepted_at IS 'Timestamp when user accepted Terms of Service. NULL means not yet accepted.';
