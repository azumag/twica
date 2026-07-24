# Database runtime（PlanetScale 固定）

Issue #708 / #803 の完了後、root app と error-reporter Worker の runtime DB は
PlanetScale PostgreSQL のみを使用する。段階移行で使った PostgREST 経路・接続先
切替フラグ・旧 Hyperdrive binding は廃止済みであり、ロールバック先にはしない。

## 接続

- production / preview: `HYPERDRIVE_PLANETSCALE`
- local development: `DATABASE_URL_PLANETSCALE`
- migration / CLI: `DATABASE_URL` または workflow の
  `PLANETSCALE_DATABASE_URL`

`src/lib/db/client.ts` は Cloudflare runtime ではリクエスト単位、Node では
プロセス単位で postgres.js + Drizzle のハンドルを再利用する。接続設定が無い
場合は fail-closed とし、別 DB へ暗黙にフォールバックしない。

## デプロイと migration

1. schema 変更は `supabase/migrations/`（共通の履歴）または
   `db/planetscale/migrations/`（PlanetScale 専用）へ追加する。
2. `.github/workflows/planetscale-migrate.yml` で migration を適用・検証する。
3. application deploy workflow に migration を戻さない。deploy の
   `cancel-in-progress` により DDL が中断されることを防ぐため、両 workflow は
   独立させる。
4. `GET /api/admin/db-health?target=planetscale` で接続と
   `serverVersionMajor` / `latencyMs` を確認する。`target=supabase` は 400。

## 障害時

- DB 接続障害を旧 DB への切替で回避しない。
- `[db:pg]` / `[DB Retry]` ログ、Cloudflare Hyperdrive metrics、
  PlanetScale metrics を確認する。
- 読み取りは `withDbRetry(..., { idempotent: true })` で一時的な接続断を再試行
  できる。非冪等書き込みは commit 結果不明時の二重実行を避けるため、明示的な
  根拠なしに retry を有効化しない。
- ガチャの `execute_gacha_transaction` が欠落している場合は fail-closed。
  原子性のない複数クエリへ縮退させない。

## CI ガード

`npm run check:supabase-shutdown` は以下の退行を拒否する。

- runtime からの Supabase SDK / admin facade / credential 参照
- `HYPERDRIVE_SUPABASE`、`DATABASE_URL_SUPABASE`
- runtime の旧 driver/target 環境変数
- 削除済み `src/lib/supabase/*` / `src/lib/db/flags.ts` /
  `src/lib/db/target.ts` の再追加
- root/analysis package への `@supabase/*` 再追加
- deploy/smoke workflow への Supabase migration・secret 再導入

切替期間の詳細な判断記録は `docs/db-phase2-runbook.md` に履歴として残す。
