-- migration-transaction: required
-- migration-providers: planetscale
--
-- analysis一覧は既存の「部分一致」検索契約（ILIKE '%query%'）を維持する。
-- PostgreSQL標準のpg_trgmを有効化し、後続のGIN索引でこの契約をDB側から
-- 支える。拡張の有効化自体は短い通常transactionで完了するため、索引作成の
-- 長い処理とは別migrationに分ける。

CREATE EXTENSION IF NOT EXISTS pg_trgm;
