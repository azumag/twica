# analysis ダッシュボードの DB 権限

analysis ダッシュボードの管理 API は `analysis/dev/adminApiPg.ts` から
PlanetScale PostgreSQL へ直接接続します。これはローカル開発用の Node process であり、
Cloudflare Worker の Hyperdrive binding を共有しません。接続先は
`analysis/.env.local` の `DASHBOARD_DATABASE_URL` だけです。

## 原則

- `DASHBOARD_DATABASE_URL` は production / preview ごとに分離した限定ロールの接続文字列にする。
- 管理者・所有者ロールの接続文字列を dashboard に渡さない。
- SSL を必須にし、接続文字列の `sslmode` を弱めない。
- DB 未設定、RPC 欠落、権限不足は安全に失敗させる。別の DB や旧経路へフォールバックしない。
- Supabase API key、SDK、CLI を dashboard の設定・実装・運用に追加しない。

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
接続文字列は各環境の `analysis/.env.local` にのみ保存します。SQL の正本は
`db/planetscale/` と現行 migration です。運用ドキュメントに固定パスワードや接続文字列を
記録しません。

## 確認手順

1. dashboard を対象環境と同じ限定ロールで起動する。
2. 読み取り endpoint で集計 RPC が成功することを確認する。
3. 必要な管理操作だけを実施し、許可していない DML が拒否されることを確認する。
4. `permission denied`、RPC 欠落、接続失敗を成功扱いにしていないことをログとテストで確認する。

新しい dashboard endpoint を追加するときは、SQL を文字列連結で組み立てず、
postgres.js のパラメータ化を使います。権限追加は endpoint ごとに必要性を説明し、
production / preview 双方で最小権限を検証します。

## 歴史的注記

以前の移行記録には旧 API gateway を前提とする JWT / role の説明があります。これは現在の
direct PostgreSQL 権限を理解するための schema 上の背景であり、旧 API、SDK、環境変数を
復元する手順ではありません。
