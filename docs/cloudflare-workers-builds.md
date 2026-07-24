# Cloudflare Workers Builds 運用

TwiCa の本体 Next.js Worker は Cloudflare Workers Builds がデプロイの正本です。
GitHub Actions はアプリ本体を二重デプロイせず、PlanetScale migration と補助 Worker を担当します。

## Workers Builds 設定

| 環境 | Worker | Git branch | Build command | Deploy command |
| --- | --- | --- | --- | --- |
| production | `twica` | `main` | `npm run workers:build` | `npm run cloudflare:deploy:production` |
| preview | `twica-preview` | `preview` | `npm run workers:build` | `npm run cloudflare:deploy:preview` |

- Root directory は repository root、Node.js は `.node-version` の値を使う。
- Workers Builds に設定するのは公開ビルド値だけです。例:
  `NEXT_PUBLIC_APP_URL`、`NEXT_PUBLIC_TWITCH_CLIENT_ID`、
  `NEXT_PUBLIC_CF_IMAGES_ENABLED`。
- `TWITCH_CLIENT_SECRET`、`TWITCH_EVENTSUB_SECRET`、`CSRF_TOKEN_SALT` 等の機密値は
  Worker runtime Secret にのみ設定します。
- DB は production / preview とも `HYPERDRIVE_PLANETSCALE` binding が唯一の runtime 経路です。
  connection string を Workers Builds の変数として複製しません。

Cloudflare Workers Builds を有効にするリポジトリ変数は
`CLOUDFLARE_WORKERS_BUILDS_ENABLED=true` です。有効時、
`.github/workflows/deploy-cloudflare.yml` の legacy app deploy は意図的に skip されます。

## GitHub Actions の責務

### PlanetScale migration

`.github/workflows/planetscale-migrate.yml` は `main` と `preview` の push ごとに、
対応する GitHub Environment の `PLANETSCALE_DATABASE_URL` を使って次を実行します。

```bash
node scripts/db-migrate.js apply --provider=planetscale
node scripts/db-migrate.js verify --provider=planetscale
```

Migration workflow は deploy workflow と分離されています。デプロイの
`cancel-in-progress` が DB 書き込みを途中で停止しないようにするためです。自動適用は
加法的 migration に限ります。列削除・rename・型変更などの contract 変更は、
expand/contract 手順とアプリのデプロイ順を明示して個別に実施してください。

### 補助 Worker

`deploy-cloudflare.yml` は以下をデプロイします。

- `workers/overlay-realtime`: `main` / `preview` の各環境
- `workers/error-reporter`: production

Error Reporter も `HYPERDRIVE_PLANETSCALE` を介して同じ PlanetScale 正本を参照します。
本体 Worker と補助 Worker の DB 接続先を別々に変更してはいけません。

## リリース確認

1. 対象 branch の Workers Builds が成功し、意図した Worker version が active であることを確認する。
2. 対応する PlanetScale migration workflow の apply と verify が成功していることを確認する。
3. 補助 Worker を変更した場合は、該当 deploy job も成功していることを確認する。
4. 本番では EventSub、ガチャ引換、チャット通知、overlay の順に監視し、エラー報告を確認する。

失敗時は旧 Worker version へロールバックする前に、適用済み migration が後方互換かを確認します。
DB migration を Worker version のロールバックだけで戻したものと見なしてはいけません。

## 廃止済み経路

過去には別 DB 向け CLI と GitHub Actions による本体アプリ deploy を運用していましたが、
Issue #803 で廃止しました。古い runbook の `db push`、migration history repair、
旧 DB URL / Secret の設定を実行しないでください。現行環境にそれらの設定を追加すると、
接続先の分岐と誤デプロイを再導入します。
