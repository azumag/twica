# analysis ダッシュボード admin backend の DB 権限

Issue #700（#574 / #568 Phase 1-5）受け入れ条件「read/writeに必要な最小DB権限が
文書化される」に対応するドキュメント。対象は `analysis/dev/localAdminApi.ts`
（Vite dev plugin、`ANALYSIS_DB_DRIVER` 未設定時の既定経路 = Supabase/PostgREST）
と `analysis/dev/adminApiPg.ts`（`ANALYSIS_DB_DRIVER=pg` 時の postgres.js 直結経路）
の両方。デフォルト経路の切替タイミング自体は #699（本番カットオーバー）の管轄で
あり、本ドキュメントは権限要件の整理のみを扱う。

姉妹ドキュメント: `docs/db-driver-migration.md`（root app の `DB_DRIVER` 移行、
同じ「専用ロール + `grant service_role to <role>`」パターンの元ネタ）。本ドキュメントは
root app 用ロールとは**別に**、analysis ダッシュボード専用の
`DASHBOARD_DATABASE_URL` ロールを想定する（用途が異なる別ロールを使うことで、
片方の権限変更がもう片方に影響しない）。

## 1. 権限モデルの全体像

analysis ダッシュボードの pg 直結経路が触るオブジェクトは3種類に分類できる。

| 分類 | 例 | 権限の与え方 |
| --- | --- | --- |
| 読み取り専用 RPC | `get_analysis_overview()` 等（`00073_add_analysis_dashboard_rpcs.sql`） | `SECURITY DEFINER` + `REVOKE ALL FROM PUBLIC` + `GRANT EXECUTE TO service_role` |
| テーブル直接 DML | `support_codes` への INSERT、`announcements` の UPDATE 等 | `00047_explicit_public_table_grants.sql` の明示 `GRANT ... TO service_role` + RLS ポリシー |
| 書き込み系 RPC | `revoke_support_code()` 等（既存の main app 由来） | `REVOKE ALL FROM PUBLIC` + `GRANT EXECUTE TO service_role`。`SECURITY DEFINER` 指定なし（＝`SECURITY INVOKER`）のため、実行時の RLS は呼び出し側ロールで評価される |

いずれも `service_role` への `GRANT`/`TO service_role` ポリシーが前提のため、
`DASHBOARD_DATABASE_URL` に設定する Postgres ロールは
**`service_role` のメンバーである必要がある**（`grant service_role to <role>`）。
これは `docs/db-driver-migration.md` の Hyperdrive 用ロールと全く同じ理由・同じ
仕組み（PostgREST の JWT クレームを経由しない pg 直結では、ロールの権限は
メンバーシップで解決するしかない）。

## 2. 読み取り専用 RPC（`get_analysis_*` 等）

`00073_add_analysis_dashboard_rpcs.sql` で追加された次の5関数はすべて
`get_analysis_overview()` と同一パターン（`LANGUAGE sql`, `SECURITY DEFINER`,
`SET search_path = public`, 呼び出し元は `REVOKE ALL ... FROM PUBLIC` の上で
`GRANT EXECUTE ... TO service_role`）:

- `get_analysis_overview()`
- `get_analysis_streamer_leaderboard()`
- `get_analysis_users()`
- `get_analysis_streamers()`
- `get_analysis_gacha_summary(p_from_date TIMESTAMPTZ, p_streamer_id UUID)`

同じパターンを使う既存 RPC（analysis ダッシュボードの他エンドポイントが利用、
main app 由来）:

- `get_user_card_counts(p_twitch_user_id TEXT, p_streamer_id UUID)`
  （`00031_add_get_user_card_counts.sql`、`getUserCardsSummaryPg` が使用）
- `get_gacha_drop_stats(p_streamer_id UUID, p_from_date TIMESTAMPTZ, p_limit_per_card INTEGER)`
  （`00038` 以降で拡張、`getDropRateStatsPg` が使用）

`SECURITY DEFINER` のため、これらの関数本体は定義者（migration 実行ロール、
通常は `postgres`）の権限で実行される。呼び出し元ロールに必要なのは
「関数を呼び出す（EXECUTE）権限」だけであり、関数内部が参照するテーブルへの
直接権限は不要。逆に言えば、`service_role` を継承していても EXECUTE 権限が
無ければ `permission denied for function` で失敗する
（`adminApiPg.ts` の `resolveDashboardDatabaseUrl` 冒頭コメント参照）。

## 3. テーブル直接 DML（書き込み系 endpoint）

`adminApiPg.ts` は RPC を経由せず直接 `INSERT`/`UPDATE`/`DELETE` を発行する
書き込みエンドポイントを複数持つ。対象テーブルと、そのテーブルの RLS ポリシーの
種類（＝ pg 直結ロールに追加で何が必要か）を整理する。

| テーブル | 使用箇所 | RLS ポリシー | pg 直結ロールへの追加要件 |
| --- | --- | --- | --- |
| `support_codes` | `createSupportCodePg`（INSERT）、`updateSupportCodeStatusPg`（UPDATE）、`revokeSupportCodePg`（RPC経由でUPDATE） | `FOR ALL USING (auth.role() = 'service_role')`（`00017_add_support_plans.sql`、JWTクレーム述語） | `ALTER ROLE ... BYPASSRLS` が必須 |
| `user_licenses` | `revokeSupportCodePg`（RPC経由でDELETE）、`listLicensesPg`（SELECT） | 同上（JWTクレーム述語） | `ALTER ROLE ... BYPASSRLS` が必須 |
| `announcements` | `createAnnouncementPg`/`updateAnnouncementPg`（INSERT/UPDATE）、`deleteAnnouncementPg`（DELETE） | `TO service_role` のロールベースポリシー（`00016_add_announcements.sql`） | `grant service_role to <role>` のメンバーシップのみで通過（BYPASSRLS 不要） |
| `announcement_reads` | `listAnnouncementsPg`（SELECT、既読数の相関サブクエリ） | 同上（ロールベース） | 同上（BYPASSRLS 不要） |
| `support_inquiries` | `updateSupportInquiryStatusPg`（UPDATE）、`getSupportInquiriesPg`（SELECT） | 同上（ロールベース、`00019_add_support_inquiries.sql`） | 同上（BYPASSRLS 不要） |
| `support_inquiry_messages` | `createSupportInquiryMessagePg`（INSERT）、`listSupportInquiryMessagesPg`（SELECT） | 同上（ロールベース） | 同上（BYPASSRLS 不要） |

**BYPASSRLS が必要な理由（`support_codes`/`user_licenses` のみ）**:
これらのテーブルの RLS ポリシーは `auth.role() = 'service_role'` という
JWT クレーム述語で書かれている。PostgREST 経由（従来の Supabase 経路）では
JWT の `role` クレームに基づき PostgREST が接続の Postgres ロールを
`service_role` へ `SET ROLE` するため、後述のとおり `service_role` 自体が持つ
`BYPASSRLS` 属性によりポリシー評価そのものが行われずに済む
（「ポリシーの述語を満たして通過する」のではなく「ポリシー評価が
スキップされる」）。pg 直結には JWT クレームという概念自体が存在しない。加えて
`revoke_support_code()` は `SECURITY DEFINER` を指定していない（＝
`SECURITY INVOKER`、`docs/db-driver-migration.md` が `activate_support_code` /
`deactivate_all_licenses` について述べているのと同じ構造）ため、RPC 経由でも
呼び出し側ロールの RLS がそのまま評価される。`service_role` ロール自体は
`BYPASSRLS` 属性を持つが、ロール属性は `grant service_role to <role>` という
メンバーシップでは継承されない（PostgreSQL の仕様）。したがって
`DASHBOARD_DATABASE_URL` のロールにも明示的に `alter role ... bypassrls;` を
実行しない限り、`support_codes`/`user_licenses` への書き込みは
0件更新（無言の失敗）または RLS 違反になる。

**BYPASSRLS が不要な理由（`announcements` 系 / `support_inquiries` 系）**:
これらは `CREATE POLICY ... TO service_role` というロールベースポリシーで
書かれている。この形式は「現在の実行ロールが `service_role` のメンバーかどうか」を
PostgreSQL のロールメンバーシップ機構で直接判定するため、JWT クレームに依存しない。
`grant service_role to <role>` だけで正しく通過する。

**テーブル権限（GRANT）そのもの**: RLS はあくまで「行」のフィルタであり、
「そもそもそのテーブルに INSERT/UPDATE/DELETE できるか」という基礎権限は別に
`GRANT` が必要。上記6テーブルはいずれも `00047_explicit_public_table_grants.sql`
で `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.<table> TO service_role;`
済みのため、`grant service_role to <role>` すればテーブル権限も継承される
（`gacha_history` は例外で、`00047_explicit_public_table_grants.sql` では
`SELECT`/`INSERT` のみが付与されている。`DELETE` はその後
`supabase/migrations/20260712211038_explicitly_grant_gacha_history_delete.sql`
（issue #689）で service_role へ明示 GRANT 済みのため、現在未付与なのは
`UPDATE` のみ。analysis ダッシュボードは `gacha_history` へ書き込まないため
いずれにせよ影響なし）。

## 4. 書き込み系 RPC（`revoke_support_code` 等）

`revokeSupportCodePg` が呼ぶ `revoke_support_code(p_code_id UUID)`
（`00017_add_support_plans.sql`）は `REVOKE ALL FROM PUBLIC` +
`GRANT EXECUTE TO service_role` のみで `SECURITY DEFINER` を指定していない。
「3. テーブル直接 DML」の節で述べたとおり、この関数が内部で行う
`UPDATE support_codes` / `DELETE FROM user_licenses` は呼び出し側ロールの
権限・RLS で評価されるため、EXECUTE 権限に加えて上記のテーブル権限
（`support_codes`/`user_licenses` への GRANT と BYPASSRLS）が両方必要になる。

## 5. ロール作成の具体例

`docs/db-driver-migration.md` の手順1と同じ要領で、analysis ダッシュボード専用の
ロールを作成する（root app の Hyperdrive 用ロールとは別に用意することを推奨。
理由は6章参照）。Supabase SQL Editor で prod / preview 各プロジェクトに対して実行:

```sql
-- analysis ダッシュボード専用ロール。既定の postgres ロール（superuser相当）は使わない。
create role twica_analysis login password '<強力なパスワード>';

-- get_analysis_*() 等のRPC実行 (EXECUTE) と、support_codes/announcements等への
-- テーブルDMLの両方をservice_role経由でまとめて継承する
-- （00047_explicit_public_table_grants.sql の明示GRANT、および
--   「FOR ALL TO service_role」形式のRLSポリシーを継承）。
grant service_role to twica_analysis;

-- support_codes / user_licenses は auth.role() というJWTクレーム述語のRLSで
-- 守られており、pg直結にはJWTクレームが存在しないため上のGRANTだけでは
-- 書き込みが通らない（詳細は本ドキュメント3章参照）。BYPASSRLSはsuperuser化
-- ではなく、GRANTされたDML権限の範囲内でのみ動作する。
alter role twica_analysis bypassrls;
```

取得した Direct connection 接続文字列のユーザー名/パスワードを上記ロールに
差し替えたものを `DASHBOARD_DATABASE_URL`（`analysis/.env.local` 等、
`ANALYSIS_DB_DRIVER=pg` の場合のみ参照される）に設定する。
`sslmode` パラメータは削らずそのまま使うこと（平文接続へのダウングレード防止、
`docs/db-driver-migration.md` と同じ注意）。

## 6. read/write ロール分離について（未実施・オーナー判断待ち）

issue #700 の構成案は「read-only route用roleとwrite route用roleを分離するか、
専用roleへ必要最小権限を付与する」の両方を選択肢として挙げているが、
**本ドキュメント作成時点ではロール分離は実施していない**。
現状は5章の単一ロール（`twica_analysis`、読み取り RPC の EXECUTE と
書き込み系テーブル DML の両方を保持）を共有ロールとして使う前提で運用する。

分離する場合に検討が必要な点（正直に列挙。今回は判断・実施しない）:

- 読み取り専用ロールは `get_analysis_*` 系・`get_user_card_counts`・
  `get_gacha_drop_stats` への EXECUTE のみで足りる（テーブルへの直接 GRANT や
  BYPASSRLS は不要）。`GET` ルート（overview/users/streamers/gacha 系）専用に
  すれば、万一 SQL 構築にバグがあっても書き込みは物理的に不可能という防御になる。
- 書き込みロールは3章/4章のテーブル DML・RPC EXECUTE に加え、
  `support_codes`/`user_licenses` 用の BYPASSRLS が必要。BYPASSRLS は
  テーブル単位で絞れない（ロール属性のため全テーブルに一律適用される）点に
  注意。より厳密に絞るなら、JWTクレーム述語のRLSポリシー自体を
  ロールベース（`TO service_role`）へ書き換えるマイグレーションが必要になり、
  main app（PostgREST 経由の既存アクセス）への影響評価が別途要る。
- Vite dev plugin（`localAdminApi.ts`/`adminApiPg.ts`）は単一プロセス・単一
  `postgres.Sql` シングルトンで動くため、ロールを分けるなら接続を2本持つ
  実装変更が必要（現状は `DASHBOARD_DATABASE_URL` 1本のみを読む設計、
  `adminApiPg.ts` の `getAnalysisSql()` 参照）。
- 運用上のロール管理コストが増える（prod/preview × read/write の最大4ロール）。
  ローカル専用の管理ダッシュボードという性質上、コストに見合うリスク低減が
  あるかはオーナー判断が必要。

## 7. 参考ソース

- `analysis/dev/adminApiPg.ts` 冒頭コメント・`resolveDashboardDatabaseUrl()` の
  JSDoc（本ドキュメントの元になったコード内コメント）
- `supabase/migrations/00073_add_analysis_dashboard_rpcs.sql`
  （`get_analysis_*` の定義・GRANT/REVOKE）
- `supabase/migrations/00047_explicit_public_table_grants.sql`
  （テーブル単位の明示 GRANT 一覧）
- `supabase/migrations/00016_add_announcements.sql` /
  `00017_add_support_plans.sql` / `00019_add_support_inquiries.sql`
  （各テーブルの RLS ポリシー定義）
- `docs/db-driver-migration.md`（root app 側の同種ロール作成手順・BYPASSRLS の
  背景説明。本ドキュメントはそのanalysis版）
