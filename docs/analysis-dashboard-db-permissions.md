# analysis ダッシュボードの DB 権限

analysis ダッシュボードの管理 API は `analysis/dev/adminApiPg.ts` から
PlanetScale PostgreSQL へ直接接続します。これはローカル開発用の Node process であり、
Cloudflare Worker の Hyperdrive binding を共有しません。接続先は、起動 mode ごとの
env ファイルにある `DASHBOARD_DATABASE_URL` だけです。

| 起動コマンド | Vite mode | 接続文字列の置き場所 | 接続先 |
| --- | --- | --- | --- |
| `npm run dev` | `production` | `analysis/.env.production.local` | production 用限定ロール → `prod` DB |
| `npm run dev:preview` | `preview` | `analysis/.env.preview.local` | preview 用限定ロール → `preview` DB |

`analysis/.env.local` には `DASHBOARD_DATABASE_URL` を置きません。Vite は `.env.local` を
mode に関係なく読み込むため、置くと `dev:preview` で production の接続文字列が使われる
（またはその逆の）取り違えが起きます。mode 別ファイル（`.env.[mode].local`）は
`.env.local` より優先されますが、片方の mode のファイルを作り忘れたときに `.env.local` へ
黙ってフォールバックするので、`.env.local` 自体に置かないことで防ぎます。
いずれのファイルも root の `.gitignore`（`.env*`）でコミット対象外です。

## 原則

- `DASHBOARD_DATABASE_URL` は production / preview ごとに分離した限定ロールの接続文字列にする。
- 管理者・所有者ロールの接続文字列を dashboard に渡さない。
- SSL を必須にし、接続文字列の `sslmode` を弱めない。
- DB 未設定、RPC 欠落、権限不足は安全に失敗させる。別の DB や旧経路へフォールバックしない。
- Supabase API key、SDK、CLI を dashboard の設定・実装・運用に追加しない。

## 開発サーバーの公開範囲

analysis の Vite dev server は `/__admin` 管理 API をホストし、その Node process が
`DASHBOARD_DATABASE_URL` で DB へ接続します。そのため dev server 自体の到達範囲は
DB 権限と同じ強さの境界として扱います（#1899）。

- 既定は loopback（`127.0.0.1`）のみ。同じ LAN の第三者からは到達できません。
- 外部公開が必要な場合だけ `TWICA_ANALYSIS_DEV_ALLOW_EXTERNAL=1` を明示して起動します。
  `'1'` 以外の値（`true`/`yes` 等）では公開せず警告します。設定漏れで公開側へ倒れない
  fail-closed の挙動です。
- 変数名に `VITE_` 接頭辞を付けないのは、Vite が `envPrefix` 付きの変数をクライアントの
  `import.meta.env` へ露出するためです。サーバーの bind 判断をクライアント可視の命名に
  しないでください。
- 外部公開時も `/__admin` は loopback 以外の送信元・Host・Origin を拒否します
  （`analysis/dev/localAdminApi.ts`）。つまり**外部公開しても管理 API は使えず**、
  画面のレイアウト確認など読み取り専用の確認に限られます。データ操作が必要な場合は
  管理 PC 上で loopback のまま操作してください。
- `server.allowedHosts` は外部公開時も設定しません。Vite は IP リテラルと `localhost`
  を常に許可し、未知のホスト名だけを拒否します。`allowedHosts: true` を渡すと Host
  検証が無効化され、攻撃者ドメインを LAN IP へ再解決する DNS rebinding が成立します。
  LAN から使う場合は `http://<管理PCのIP>:5173/` のように IP 直指定してください。
- 公開した事実は起動時に警告として必ず出力されます。
- 信頼できないネットワーク（公衆無線など）では `1` を設定しないでください。

## 必要な権限

`adminApiPg.ts` は次の二系統を使います。

| 操作 | 対象 | 必要な権限 |
| --- | --- | --- |
| 集計の読み取り | `get_analysis_*`、カード・ガチャ集計関数 | 対象関数の `EXECUTE` |
| 管理操作 | support code、license、announcement、support inquiry への DML と関連 RPC | 対象テーブルの最小 DML と対象関数の `EXECUTE` |

現行 schema の一部の RLS policy は `service_role` メンバーシップを前提にしています。
そのため限定 dashboard ロールには、schema で定義された必要最小のテーブル権限・関数権限に加え、
既存 policy を満たすロールメンバーシップが必要です。`BYPASSRLS` は
`support_codes` / `user_licenses` の JWT 依存 legacy policy を direct PostgreSQL 接続で扱う場合にのみ
必要になります。ロール属性は広い権限なので、付与前に対象テーブルを再確認し、より狭い
ロールベース policy に置換できる場合はそちらを優先します。

ロール変更は PlanetScale の管理接続を持つ担当者が production と preview に別々に適用し、
接続文字列は上表の mode 別 env ファイルにのみ保存します。SQL の正本は
`db/planetscale/` と現行 migration です。運用ドキュメントに固定パスワードや接続文字列を
記録しません。

## 限定ロールの作り方

現行のロールは `twica_analysis_prod`（production）と `twica_analysis_preview`（preview）です。
属性とメンバーシップは次のとおりです。

| 項目 | 値 | 理由 |
| --- | --- | --- |
| `LOGIN` | あり | dashboard が直接接続するため |
| `BYPASSRLS` | あり | `support_codes` / `user_licenses` の policy は `auth.role() = 'service_role'` だが、PlanetScale 上の `auth.role()` は常に `'anon'` を返すため、メンバーシップだけでは通らない |
| `CONNECTION LIMIT` | 5 | dev server 1台分で足り、接続漏れが本番の接続枠を食い潰すのを防ぐ |
| メンバーシップ | `service_role` | `get_analysis_*` の `EXECUTE` と、`TO service_role` の policy・テーブル権限を継承するため |
| `SUPERUSER` / `CREATEDB` / `CREATEROLE` | なし | 既定値のまま（下記の注意を参照） |

prod と preview は同じ PlanetScale クラスタ内の別 database のため、ロールはクラスタ全体で
共有されます（`docs/history/migration/DB_PHASE2_RUNBOOK.md` 1.1節）。prod 用ロールでも `preview` DB に接続
できる点は承知のうえで、認証情報だけを環境ごとに分けています。

作成手順:

1. パスワードはローカルで生成し、SQL には SCRAM-SHA-256 の verifier
   （`SCRAM-SHA-256$4096:<salt>$<StoredKey>:<ServerKey>`）だけを載せる。平文パスワードは
   env ファイルにだけ書き、PlanetScale コンソール・チャット・Issue には出さない。
2. PlanetScale のブランチ `main` の Console（Database は `prod` / `preview` のどちらでもよい）で、
   次を **1文ずつ** 実行する。Console は複数文の一括実行と `BEGIN` / `COMMIT` に対応していない。

   ```sql
   DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '<role>') THEN CREATE ROLE <role> LOGIN; END IF; END $$;
   ALTER ROLE <role> WITH LOGIN BYPASSRLS CONNECTION LIMIT 5 PASSWORD '<SCRAM-SHA-256 verifier>';
   GRANT service_role TO <role>;
   ```

3. 接続文字列は `postgresql://<role>.<branch_id>:<password>@<host>:5432/<prod|preview>?sslmode=verify-full&sslrootcert=system`
   の形にする。PlanetScale はユーザー名の末尾の `.<branch_id>` でブランチへ振り分ける。
   host と branch id は既存の Hyperdrive 設定や PlanetScale ダッシュボードで確認する。
4. 下記「確認手順」で、ログイン・`get_analysis_*` の実行・RLS 対象テーブルの読み取りを確認する。

注意:

- PlanetScale Console の接続ロールは SUPERUSER ではないため、`ALTER ROLE` に `NOSUPERUSER`
  を明示すると `Only roles with the SUPERUSER attribute may change the SUPERUSER attribute.`
  で拒否される（2026-11-10 に実測）。`SUPERUSER` / `CREATEDB` / `CREATEROLE` は新規ロールでは
  既定で無効なので、`NO*` 属性は書かない。
- Console のタブを長時間開いたままにすると、Console 自身の一時ロールが失効し
  `password authentication failed for user "pscale_api_..."` になる。タブを再読み込みすれば直る
  （作成中のロールとは無関係のエラー）。
- `npm run check:analysis-dashboard-vs-sql` は env ファイルを読まず `process.env` だけを見る。
  実行時は対象環境の値を明示的に渡す（例:
  `DASHBOARD_DATABASE_URL="$(grep '^DASHBOARD_DATABASE_URL=' analysis/.env.preview.local | cut -d= -f2-)" npm run check:analysis-dashboard-vs-sql`）。
  接続文字列は `&` を含むため、env ファイルをシェルで `source` しない。

## 限定 read 接続の準備責任

Preview 実経路ゲート #6（#1077）を実行する前に、**PlanetScale の管理接続を持つ担当者**が
対象環境専用の限定 read ロールを用意し、その接続文字列を検証を実行する環境の
`DASHBOARD_DATABASE_URL` にだけ安全に注入します。比較スクリプトの実行担当者が、
管理接続や production 用アプリ接続を代用して検証を続行してはいけません。

- preview と production の限定 read ロール・接続文字列は必ず分離する。
- `DATABASE_URL_PLANETSCALE` / `PLANETSCALE_DATABASE_URL` を代替値として使わない。
- `DASHBOARD_DATABASE_URL` が未準備なら比較を実行せず、管理接続を持つ担当者へ払い出しを依頼する。
- 接続文字列そのものは Issue / PR / CI ログ / チャットへ転記しない。実行結果を共有する場合も数値と secret は記録しない。
- ロール払い出し後は、下記「確認手順」で権限不足・RPC 欠落・接続先取り違えを fail-closed で確認する。

この分担により、「限定 read 接続が無いため同じ preview-gate Issue を再起票する」状態と、
検証のために広い権限の接続を流用する状態の両方を避けます。

## 確認手順

1. dashboard を対象環境と同じ限定ロールで起動する。
2. 読み取り endpoint で集計 RPC が成功することを確認する。
3. 必要な管理操作だけを実施し、許可していない DML が拒否されることを確認する。
4. `permission denied`、RPC 欠落、接続失敗を成功扱いにしていないことをログとテストで確認する。
5. `get_analysis_*()` RPC 自体の集計が正しいことは、`npm run check:analysis-dashboard-vs-sql`
   （`scripts/compare-analysis-dashboard-vs-sql.mjs`, #1077）で検証する。RPCを経由しない
   素朴な COUNT/GROUP BY を独立に発行し、`get_analysis_overview` /
   `get_analysis_users_summary` / `get_analysis_streamers_summary` /
   `get_analysis_gacha_summary` の戻り値（users/streamers/cards、
   today/week/month/total gacha、unique users、rarity）と突き合わせる。
   `DASHBOARD_DATABASE_URL` にのみ対象環境の限定readロール接続文字列を設定して実行する
   （`DATABASE_URL_PLANETSCALE`/`PLANETSCALE_DATABASE_URL` はそれぞれ用途・権限が別の
   接続文字列のためフォールバックしない。誤って management ロールで preview を検証したつもりが
   production に接続するような事故を防ぐため）。全クエリは単一の read-only スナップショット
   （`REPEATABLE READ READ ONLY`）内で発行するため、比較の途中に書き込みが挟まっても
   誤検知しない。出力はその場の差分調査用であり、Issue/PR/ログへ実数値を転記しない。
   全期間の `gacha_history` を走査する集計は production 規模では本スクリプトの既定値
   （30秒。PostgreSQL自体の既定は無制限）を超えうる。その場合は不一致ではなくタイムアウト
   である旨が出力されるので、`DASHBOARD_COMPARE_STATEMENT_TIMEOUT`（例: `"2min"`。`0`は
   タイムアウト自体を無効化してしまうため拒否される）で上限を延ばして
   再実行する。なお today/week/month の境界式は RPC 側の定義をほぼ書き写しているため、
   境界定義そのものが最初から誤っているケース（両側が同じ誤りを持つ）はこの比較では
   検出できない。

新しい dashboard endpoint を追加するときは、SQL を文字列連結で組み立てず、
postgres.js のパラメータ化を使います。権限追加は endpoint ごとに必要性を説明し、
production / preview 双方で最小権限を検証します。

## 歴史的注記

以前の移行記録には旧 API gateway を前提とする JWT / role の説明があります。これは現在の
direct PostgreSQL 権限を理解するための schema 上の背景であり、旧 API、SDK、環境変数を
復元する手順ではありません。
