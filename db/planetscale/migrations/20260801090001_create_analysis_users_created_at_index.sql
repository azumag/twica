-- migration-transaction: forbidden
-- migration-providers: planetscale
--
-- ページ番号の既定ソート（created_at/id tie-breaker）を支える索引。
-- 実DBの書き込みを長時間ブロックしないよう、トランザクション外の
-- CREATE INDEX CONCURRENTLY として単独適用する。forbidden migrationは
-- db-migrate.jsの制約上SQL文を1つだけ持たせ、途中失敗時も次回再試行できる
-- IF NOT EXISTSを使う。

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_created_at_analysis
  ON public.users (created_at DESC);
