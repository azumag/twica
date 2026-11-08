# docich-silence-watch

azumag/docich#3509 の段階1: docich の GitHub Actions 無音を GitHub 外
（Cloudflare Workers Cron Trigger、30 分間隔）から監視し Discord へ通知する
backstop。GitHub 側 watchdog（twica `.github/workflows/docich-actions-silence-watch.yml`）
と検知ロジック・通知文面・抑制窓（55分）を揃え、段階1は両者を並行稼働で検証する。
48h 安定後の段階2（GitHub 側の通知停止・削除）は別 PR。

## 検知ロジック（GitHub 版と同一）

- `azumag/docich`（target）と `azumag/twica`・`azumag/soviet_now`（control）の
  最新 run `created_at` と `pushed_at` を GitHub REST API で読む
- 無音 = 最新 run から2時間超過 かつ pushed_at が2時間以内（活動あるのに無い）
- 切り分け = docich のみ無音 `repo-specific` / control も無音 `platform-suspect`

## GitHub API 認証

対象は全て public repo のため読み取りは認証不要。secret `GITHUB_READ_TOKEN`
（Actions:read のみの fine-grained PAT）を設定すればレート余裕が増えるが
未設定でも匿名で動く（12 req/h 程度）。

## リソース・secret

- KV namespace（55 分抑制窓の anchor 保持）: `npx wrangler kv namespace create SILENCE_KV`
  で作成し、返された id を `wrangler.toml` の `[[kv_namespaces]]` id へ記入してから deploy
- `npx wrangler secret put DISCORD_WEBHOOK_URL`（twica 側通知先と同じ webhook）
- （任意）`npx wrangler secret put GITHUB_READ_TOKEN`

## Deploy（owner 承認後・新規リソース作成を伴う）

```sh
cd workers/docich-silence-watch
npx wrangler kv namespace create SILENCE_KV   # 返却 id を wrangler.toml へ記入
npx wrangler secret put DISCORD_WEBHOOK_URL
npx wrangler deploy
```

## 検証

- `node --test worker.test.mjs` で判定ロジックの単体テスト
- デプロイ後は `GET /observe`（dry-run・送信/KV 更新なし）で観測値を確認し、
  cron の実発火を Workers Observability で追跡する
