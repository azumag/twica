-- Migration: Add GitHub Issue tracking to support_inquiries
-- 問い合わせの GitHub Issue 自動発行のための追跡カラムを追加
--
-- 支援者が投稿した新規問い合わせ (support_inquiries) を、Cron Worker
-- (twica-error-reporter) が定期的に読み出して GitHub Issue を自動作成し、
-- メンテナへ通知する。errors テーブル (00012) と同じ Transactional Outbox
-- パターンを踏襲する（同一 Worker がエラーと問い合わせの両方を処理）。
--
-- See: https://github.com/azumag/twica/issues/633

-- Cron Worker による GitHub Issue 発行状況の追跡カラム。
-- github_issue_created: 発行済みフラグ。未処理ポーリングの対象判定に使う。
--   NOT NULL とすることで、PostgREST の eq.false フィルタから NULL 行が漏れる
--   事故を防ぐ（errors は DEFAULT のみだが、こちらはより厳密に）。
-- github_issue_number / github_issue_url: 作成された Issue の参照情報（監査用）。
--
-- 【重要】既存行のバックフィル方針:
--   本機能は「新規問い合わせ」の通知が目的なので、マイグレーション適用時点で
--   既に存在する問い合わせ（解決済み・クローズ済みを含む過去分）を遡って
--   大量に Issue 化してはならない。そこで DEFAULT TRUE で列を追加して既存行を
--   すべて「発行済み(TRUE)」にし、その後 DEFAULT を FALSE に切り替えることで、
--   以後にアプリが INSERT する新規行だけが未処理(FALSE)＝処理対象になるようにする。
--   ADD COLUMN ... DEFAULT による既存行の充填は UPDATE トリガを発火させないため、
--   既存行の updated_at は書き換わらない（UPDATE 文でのバックフィルは不可）。
--   PostgreSQL 11+ では定数 DEFAULT 付きの列追加・DEFAULT 変更いずれも
--   メタデータのみの操作で、テーブル全体の書き換えや長時間ロックは発生しない。
ALTER TABLE support_inquiries
  ADD COLUMN IF NOT EXISTS github_issue_created BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS github_issue_number INTEGER,
  ADD COLUMN IF NOT EXISTS github_issue_url TEXT;

-- 以後の新規問い合わせは未処理(FALSE)で始まり、Cron Worker が拾って Issue 化する。
ALTER TABLE support_inquiries
  ALTER COLUMN github_issue_created SET DEFAULT FALSE;

-- 未処理問い合わせの検索を高速化（Cron Worker が定期的にクエリする対象）。
-- 部分インデックスで github_issue_created = FALSE のみを対象にしてサイズを最小化。
-- created_at 昇順（FIFO）で取得するため created_at をキーにする（errors 版の
-- idx_errors_pending は先頭列に定数の github_issue_created を含めていたが、
-- 部分述語で既に FALSE 固定のため created_at 単独で十分）。
CREATE INDEX IF NOT EXISTS idx_support_inquiries_pending
  ON support_inquiries(created_at)
  WHERE github_issue_created = FALSE;

COMMENT ON COLUMN support_inquiries.github_issue_created IS 'GitHub Issue 発行済みフラグ（Cron Worker が更新）- Issue #633';
COMMENT ON COLUMN support_inquiries.github_issue_number IS '発行された GitHub Issue 番号';
COMMENT ON COLUMN support_inquiries.github_issue_url IS '発行された GitHub Issue の URL';
