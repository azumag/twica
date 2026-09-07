# CSRF_TOKEN_SALT の本番設定

## 症状

本番 Worker の起動時に次のエラーが出る場合があります。

```
Error: CSRF token salt validation failed: CSRF_TOKEN_SALT is not set
```

## 原因

`CSRF_TOKEN_SALT` が対象の Cloudflare Worker に Secret として設定されていないか、32 文字未満です。これは状態変更 API の CSRF 保護に必要で、`src/lib/env-validation.ts` が実行時に検証します。

## 設定手順

### 1. Salt を生成する

32 文字以上の暗号学的乱数を生成します。値は表示・コミット・Issue への転載をしません。

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 2. Cloudflare Worker Secret として設定する

Cloudflare Dashboard の Worker ごとの **Settings → Variables and Secrets**、または Wrangler で設定します。

```bash
# production Worker (twica)
npx wrangler secret put CSRF_TOKEN_SALT --name twica

# preview Worker (twica-preview)
npx wrangler secret put CSRF_TOKEN_SALT --name twica --env preview
```

プロンプトで 1 で生成した値を入力します。production と preview には異なる Salt を設定します。Worker の Secret 変更は新しいデプロイを作るため、反映されたバージョンを確認してください。

### 3. R2 binding と実行時設定を確認する

画像・音声の保存は `R2_IMAGES` と `R2_SOUNDS` の R2 binding を使います。CSRF の設定に Blob 用トークンは不要です。必須の実行時設定は `src/lib/env-validation.ts`、binding は `wrangler.toml` を正本として確認してください。

### 4. 反映を検証する

1. Cloudflare のデプロイ完了後、Worker のログと `errors` テーブルに `CSRF_TOKEN_SALT` の検証エラーがないことを確認します。
2. 認証済みセッションで、CSRF 保護される状態変更 API を正しい同一オリジン Cookie と Origin/Referer で実行します。
3. CSRF Cookie の欠落、または不正な Origin/Referer のリクエストが拒否されることを確認します。

## ローカル開発

`.env.development.local`（Git 管理外）に開発専用値を設定します。production と同じ値をコピーしません。

```bash
CSRF_TOKEN_SALT=<32文字以上の開発専用乱数>
DATABASE_URL_PLANETSCALE=<開発用 PlanetScale 接続文字列>
```

Next.js 開発は `npm run dev:next` を使います。Worker のローカル動作を検証する場合は `npm run workers:build` 後に `npm run workers:dev` を実行します。

## セキュリティ上の注意

- Salt は最低 32 文字、環境ごとに固有の値を使います。
- Salt、Twitch Secret、DB 接続文字列を Git、ログ、Issue、チャットに書き込みません。
- Salt をローテーションすると、既存の CSRF トークンは無効になります。影響を告知し、デプロイ後に上記の動作確認をします。

## 関連資料

- [SECURITY.md](../SECURITY.md) - Security policies and CSRF protection
- [README.md](../README.md) - ローカル開発・実行時設定
- [env-validation.ts](../src/lib/env-validation.ts) - 必須環境変数の検証
- [wrangler.toml](../wrangler.toml) - Worker と R2 の binding
