-- PlanetScale Postgres 向け runtime role への GRANT / Issue #691 Chunk 1
--
-- 適用順序: db/planetscale/bootstrap.sql → db/planetscale/public-schema.sql →
-- 本ファイル、の順で最後に適用すること。`ON ALL TABLES IN SCHEMA public` /
-- `ON ALL FUNCTIONS IN SCHEMA public` はどちらも「実行時点で存在するオブジェクト」を
-- 対象にする（将来のCREATE TABLEを遡って自動対象にする構文ではない）ため、
-- baseline がテーブル・関数を作り終えた後でなければ意味を持たない。
--
-- 背景（docs/db-driver-migration.md のSupabase向け設定パターンを踏襲）:
-- Supabase側では `twica_app` ロールを作成し `grant service_role to twica_app;` +
-- `alter role twica_app bypassrls;` することで、Hyperdrive経由のpg直結接続に
-- PostgREST service-role相当の権限を持たせている（同docのセットアップ手順1参照）。
-- PlanetScaleでも同じ構造を踏襲する: `service_role` ロードへ本ファイルで
-- テーブル/関数権限を与えておき、運用者が別途 `twica_app` を作成して
-- `service_role` のメンバーにする（下記「運用者作業」参照）。
--
-- 00047_explicit_public_table_grants.sql が
-- 「Supabase no longer implicitly exposes newly-created public-schema tables to
-- PostgREST/GraphQL roles」とコメントしている通り、Supabase側は新規テーブルに
-- 自動でGRANTしない仕様のため、71ファイルの中で `service_role` へのGRANT文は
-- 00047以外にも複数の migration に散在している（00051等）。これらは
-- `pg_dump --no-privileges` により db/planetscale/public-schema.sql には
-- 一切含まれない（意図的な除外、Issue #691本文）。71ファイル分のGRANT文を
-- 個別に再現するのではなく、`ALL TABLES IN SCHEMA public` / `ALL FUNCTIONS IN
-- SCHEMA public` による一括GRANT + `ALTER DEFAULT PRIVILEGES` で将来のオブジェクトも
-- 自動的にカバーする方式を採る。理由:
--   1. `twica_app` は既に `BYPASSRLS` を持つ設計（docs/db-driver-migration.md）であり、
--      個々のテーブルごとにRLSポリシーで絞る意味がそもそも無い
--      （BYPASSRLS = RLSチェック自体をスキップする。GRANTされたDML権限の範囲でのみ
--      操作可能という制約は変わらない）。
--   2. PostgREST/anon/authenticated 経由のデータAPIモデル自体が廃止対象
--      （docs/history/migration/PLANETSCALE_MIGRATION_AUDIT.md 2.3節: 「移行完了後はこれらのポリシーを
--      app層認可に一本化して削除する方向が望ましい」）であり、個々のテーブルへの
--      個別GRANTを将来も逐一追随させる保守コストに見合わない。
--   3. `ALTER DEFAULT PRIVILEGES` により、00047が存在する理由そのもの
--      （新規テーブル作成時に自動でGRANTされない）をこちら側では起こさない設計にできる。

-- ---------------------------------------------------------------------------
-- service_role: baseline適用後に存在する全テーブル・全関数への権限
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO service_role;
GRANT USAGE ON SCHEMA extensions TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- 今後 baseline を再生成せず個別migrationでテーブル/関数を追加した場合でも、
-- 都度 grants.sql を再実行しなくて済むよう既定権限を設定する
-- （00047が生まれた根本原因＝Supabaseの新規テーブル非自動公開仕様を、
-- PlanetScale側では再現しない）。
--
-- 重要な前提（Fableレビュー M-3、必ず読むこと）:
-- `ALTER DEFAULT PRIVILEGES`（FOR ROLE句なし）は「このSQL文を実行したロール（current_user）が
-- “将来” 作成するオブジェクト」にしか適用されない（PostgreSQL仕様。他ロールが将来CREATE TABLEした
-- オブジェクトには一切効かない）。つまりこの2文が意味を持ち続けるためには、
-- 「本ファイルを適用したのと同じDB接続ロールで、以降の全ての public スキーマへの
-- CREATE TABLE/CREATE FUNCTION（`db-migrate.js apply --provider=planetscale` が実行する
-- 将来のmigrationファイル）が実行され続ける」という運用上の前提が常に成り立つ必要がある。
-- 別ロールでmigrationを適用するようになった場合、この既定権限は新ロールが作るオブジェクトには
-- 適用されず、静かに無効化される（エラーにはならないため気づきにくい）。
--
-- FOR ROLE を明示できないか検討した記録:
-- 本来は `FOR ROLE <実際にmigrationを適用するロール名>` を明示する方が安全だが、Chunk 1時点では
-- 意図的に明示していない。理由: 唯一ドキュメント化されている候補ロール `twica_app`
-- （docs/db-driver-migration.md）は `login` + `grant service_role to twica_app` +
-- `alter role twica_app bypassrls` のみが付与されるアプリ実行時ロールであり、CREATEROLE権限を
-- 持たない。一方 db/planetscale/bootstrap.sql は `CREATE ROLE service_role/anon/authenticated`
-- や `CREATE SCHEMA auth/extensions` を実行するため、`twica_app` ではこのファイル自身の適用すら
-- できない（＝ twica_app はmigration適用ロールではあり得ない）。実際にPlanetScale側でmigrationを
-- 適用する管理ロール名は Chunk 2（実PlanetScale接続）で確定する
-- （docs/planetscale-schema-baseline.md「Chunk 2 で行うこと」参照）。誤ったロール名を
-- `FOR ROLE` に固定すると「一見安全設定に見えるが実際には何のオブジェクトにも適用されない
-- default privilege」という、句を省略するより気づきにくい不具合になるため、確定するまでは
-- 明示しない判断とした。Chunk 2でmigration適用ロールが確定次第、本コメントと合わせて
-- `FOR ROLE <確定したロール名>` を追記すること。
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO service_role;

-- ---------------------------------------------------------------------------
-- 運用者作業（本ファイルには含めない。docs/db-driver-migration.md と同じ理由）
-- ---------------------------------------------------------------------------
-- `twica_app` ロードの作成はパスワードを伴う秘匿情報のため、本ファイル（gitに
-- コミットされるSQL）には含めない。docs/db-driver-migration.md のセットアップ手順1と
-- 同様、運用者が対象環境（PlanetScale prod/preview）へ個別に実行すること:
--
--   create role twica_app login password '<強力なパスワード>';
--   grant service_role to twica_app;
--   alter role twica_app bypassrls;
--
-- BYPASSRLS の必要性については docs/db-driver-migration.md の「権限に関する注意」節を
-- 参照（storage_usage/blob_files/errors/support_codes/user_licenses の5テーブルが
-- JWTクレーム述語のRLSポリシーを持ち、pg直結経路ではservice_roleメンバーシップだけでは
-- 通過できないため）。
