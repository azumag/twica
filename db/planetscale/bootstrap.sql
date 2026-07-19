-- PlanetScale Postgres 向け互換ブートストラップ / Issue #691 Chunk 1
--
-- 背景:
-- supabase/migrations/ の65〜71ファイルは、Supabase固有の以下の前提に依存している。
--   - `auth.uid()` / `auth.jwt()` / `auth.role()`（RLSポリシーのUSING/WITH CHECK句）
--   - `anon` / `authenticated` / `service_role` ロール（GRANT対象・CREATE POLICY ... TO句）
--   - `extensions` スキーマに設置された `pgcrypto`（00073が `extensions.digest(...)` を
--     明示修飾で呼び出す。#716でSupabase実運用の設置場所に合わせて修飾された）
-- db/planetscale/public-schema.sql（scripts/db-phase2/normalize-schema.mjs の生成物）は
-- これらのオブジェクトへの参照をそのまま含む（bring-as-isで持ち込む設計、
-- docs/planetscale-schema-baseline.md 参照）。そのため baseline を適用する前に、
-- 本ファイルで参照先を用意しておく必要がある。
--
-- 適用順序（重要）: 本ファイル → db/planetscale/public-schema.sql の順で適用すること。
-- 逆順だと baseline 側の CREATE POLICY ... TO service_role や
-- extensions.digest(...) を参照する関数定義が「role/schemaが存在しない」で失敗する。
--
-- 冪等性について:
-- 2026-07-19、実PlanetScale prod/previewへWeb Consoleから下記と同内容のSQLを手動実行済み
-- （Issue #691 タスク文参照）。そのため CREATE ROLE を素朴に書くと「role already exists」で
-- 失敗する。本ファイルは DO ブロックで存在チェックしてから CREATE ROLE する冪等な形に
-- 書き直している（CREATE SCHEMA IF NOT EXISTS / CREATE EXTENSION IF NOT EXISTS /
-- CREATE OR REPLACE FUNCTION はもともと冪等なのでそのままでよい）。
-- 何度実行してもエラーにならないことは、Docker実機検証で「まっさらなDB」と
-- 「既に一度bootstrap.sqlを適用済みのDB」の両方に対して適用して確認済み
-- （docs/planetscale-schema-baseline.md 参照）。
--
-- 撤去時期について（docs/planetscale-migration-audit.md 2.3節の所見を踏襲）:
-- auth.*スタブ関数・anon/authenticated/service_roleロード・それらに依存するRLSポリシーは、
-- 「文法上は動くが意味を持たないスタブ」である（pg直結経路にはJWTクレームが存在しないため
-- auth.uid()等は常にNULL/固定値を返す）。#568の既定路線どおり、認可はアプリ層
-- （Cookieセッション + `twica_app` ロールへの明示GRANT、db/planetscale/grants.sql）に
-- 一本化されており、本ファイルが作るスタブは「baseline側のDDLがエラーなく通るための
-- 構文的な前提」以上の意味を持たない。Phase 4（#568）でRLSポリシー自体をapp層認可へ
-- 統合・削除するタイミングで、本ファイルの互換スタブも合わせて撤去できる想定。

-- ---------------------------------------------------------------------------
-- 1. 拡張機能
-- ---------------------------------------------------------------------------

-- extensions スキーマ: Supabaseプロジェクトの標準構成では、pg_dumpの対象外である
-- `public`ではなく専用の`extensions`スキーマへuuid-ossp/pgcryptoを設置する
-- （Supabase自体の既定の運用。issue #691 Chunk 2で実Supabase本番に接続して実測確認した）。
CREATE SCHEMA IF NOT EXISTS extensions;

-- uuid-ossp: 当初（Chunk 1、ローカルDocker検証時点）は
-- 「db/planetscale/public-schema.sql中のDEFAULT句が`public.uuid_generate_v4()`と
-- 修飾されている」という誤った前提で`WITH SCHEMA public`としていた。
-- しかしissue #691 Chunk 2で実Supabase本番へ接続しpg_dumpした実データでは、
-- `extname='uuid-ossp'`のextnamespaceが`extensions`であり、DEFAULT句も
-- `extensions.uuid_generate_v4()`と修飾されていることを実測確認した
-- （Supabaseプロジェクトの標準構成でuuid-ossp/pgcryptoが`extensions`に
-- インストールされるため。ローカルDocker検証はSupabase固有のこの規約を
-- 再現していなかったための誤り）。`public`へインストールした状態で
-- 実baseline適用を試みると`function extensions.uuid_generate_v4() does not
-- exist`で失敗することを実機（PlanetScale preview）で確認済み。
-- pgcrypto側と同じ`extensions`へ統一する。
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;

-- pgcrypto: 00073_add_analysis_dashboard_rpcs.sql の関数本体が `extensions.digest(...)` と
-- スキーマ修飾で呼び出している（#716でSupabase実運用の設置場所=`extensions`スキーマに
-- 合わせて修飾された）。そのため `extensions` スキーマを作った上でそこにインストールする
-- 必要がある。Docker実機検証で「public に無修飾でインストールすると
-- `schema "extensions" does not exist` で00073相当の関数作成が失敗する」ことを実際に確認済み
-- （docs/planetscale-schema-baseline.md 参照）。
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ---------------------------------------------------------------------------
-- 2. Supabase互換ロード（anon / authenticated / service_role）
-- ---------------------------------------------------------------------------
-- CREATE ROLE は IF NOT EXISTS を持たない（PostgreSQLの仕様）ため、
-- pg_roles カタログを確認してから作成する DO ブロックで冪等化する。
-- 実PlanetScale prod/previewに既に作成済みのロールへ再実行しても安全
-- （Issue #691 タスク文の前提どおり）。

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. auth スキーマの互換スタブ関数
-- ---------------------------------------------------------------------------
-- 常にNULL/固定値を返すだけで認可を成立させない（issue #691本文の設計方針どおり）。
-- pg直結経路にはPostgRESTのJWTクレームが存在しないため、これらの関数は元々
-- 「文法上ポリシーが有効であるために存在する」だけで、実際の認可はアプリ層と
-- twica_app への明示GRANT（db/planetscale/grants.sql）が担う。
-- CREATE OR REPLACE FUNCTION はもともと冪等なため DO ブロックは不要。
CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULL::uuid $$;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
  LANGUAGE sql STABLE
  AS $$ SELECT '{}'::jsonb $$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT 'anon'::text $$;
