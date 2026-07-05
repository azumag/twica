# DB ドライバ移行 (PostgREST → postgres.js + Drizzle 直結) 運用ガイド

Issue #570 / #568 Phase 1。DB は Supabase のまま、データアクセス層を
PostgREST (supabase-js) から Hyperdrive + postgres.js + Drizzle 直結へ段階的に
切り替えるための基盤とその運用手順。**DB スキーマは一切変更しない。**

## 全体像とフラグ構成

```
DB_DRIVER (全体フラグ、実行時に毎回評価)
  未設定 / 'postgrest'  → 完全に従来どおり (supabase-js)。デプロイしても挙動不変
  'pg-read'             → 読み取りのみ pg 直結。書き込みは PostgREST のまま
  'pg'                  → 読み書きとも pg 直結

GACHA_DB_DRIVER (ガチャ経路専用の緊急スイッチ、#573)
  'pg' / 'postgrest'    → ガチャ経路だけ DB_DRIVER より優先して切替
  未設定                → DB_DRIVER に従う (pg のときのみ pg)
```

実装: `src/lib/db/`（flags / client / retry / errors）。パイロット適用箇所は
`src/lib/announcements.ts` の `getUnreadAnnouncements`（読み取り1本）。

## セットアップ手順（リポジトリオーナー作業）

1. **Hyperdrive 接続用の専用ロールを作成する（既定の `postgres` ロールを使わない）**。
   Supabase SQL Editor で prod / preview 各プロジェクトに対して実行:
   ```sql
   -- 既定の postgres ロールは superuser 相当で権限過剰。専用ロールを
   -- service_role のメンバーにすることで、PostgREST service-role と同等の権限
   -- （00047 等の明示 GRANT と、00024/00045/00051/00059 等の
   --  「FOR ALL TO service_role」RLS ポリシー）をそのまま継承する。
   create role twica_app login password '<強力なパスワード>';
   grant service_role to twica_app;
   ```
2. Supabase ダッシュボード → プロジェクトの **Connect** → **Direct connection** の
   接続文字列を取得し、ユーザー名/パスワードを手順 1 の専用ロールに差し替える
   （prod / preview の 2 プロジェクト分）。
   - **sslmode の注意**: 接続文字列に付いている `sslmode` パラメータは削らず
     そのまま使うこと（平文接続へのダウングレード防止）。
   - **IPv6 直結の注意**: Supabase の Direct connection は IPv4 アドオン未購入だと
     IPv6 のみの場合があり、`wrangler hyperdrive create` が到達性検証で失敗しうる。
     失敗する場合は IPv4 アドオンの購入か、Supavisor session mode の接続文字列の
     利用を検討する。
3. Hyperdrive config を 2 つ作成する（**`--caching-disabled` 必須**）:
   ```bash
   wrangler hyperdrive create twica-hyperdrive-prod \
     --connection-string="<本番の Direct connection 文字列（twica_app ロール）>" --caching-disabled
   wrangler hyperdrive create twica-hyperdrive-preview \
     --connection-string="<preview の Direct connection 文字列（twica_app ロール）>" --caching-disabled
   ```
   `--caching-disabled` の理由: Hyperdrive のクエリキャッシュはデフォルト有効
   (max_age 60s)。Phase 1 は PostgREST（毎回実クエリ）との完全パリティが目的で、
   キャッシュが有効だと overlay ポーリングの新着イベントが最大 60 秒遅延する等の
   挙動差が出る。
4. 出力された id を `wrangler.toml` の `[[hyperdrive]]` / `[[env.preview.hyperdrive]]`
   ブロック（現在コメントアウト）に記入し、コメントを解除してデプロイする。

## ローカル開発

- `next dev`（`npm run dev:next`）: `DATABASE_URL` を使う（`.env.local` 等に設定）。
- `wrangler dev`（`npm run dev`）: `[[hyperdrive]]` の `localConnectionString` を使う。

## 権限に関する注意

Hyperdrive に設定する接続は Postgres ロール直結であり、**RLS の外側**
（service-role 相当）で動く。既存の PostgREST 経由の service-role アクセスと
同等の権限であり、権限モデル上の変化はない（アプリ層の認可がこれまでどおり唯一の防壁）。

## 切替運用

env 変更はビルド不要で秒単位で反映される（Cloudflare では新デプロイ扱い）。
ロールバックは env を戻すだけ。必ず以下の順で行う:

1. フラグ未設定でマージ・デプロイ（挙動不変を確認）
2. preview に `DB_DRIVER=pg-read` → 検証 → `DB_DRIVER=pg` → 検証
3. prod で同順（pg-read → 検証 → pg）
4. 問題発生時: env を戻す（ガチャ経路のみ戻す場合は `GACHA_DB_DRIVER=postgrest`）

## 検証

- 切替前: `scripts/verify-db-schema.js` を preview / prod それぞれの
  `DATABASE_URL` で実行し、schema.ts と実 DB の差分ゼロを確認する
  （DB 接続が必要なため CI では実行しない）:
  ```bash
  DATABASE_URL="<Direct connection 文字列>" node scripts/verify-db-schema.js
  ```
- 切替後: `wrangler tail` で `[db:pg]` タグのエラーと `CONNECTION_*` 系エラーを監視する。
- preview で `DB_DRIVER=pg-read` にした際、ダッシュボードのお知らせバナー表示
  （パイロット経路 `getUnreadAnnouncements`）が postgrest 時と同一であることを
  目視確認する（日付シリアライズ差の実機確認を兼ねる）。
- preview での確認項目:
  - `statement_timeout` が Hyperdrive を透過するか未確認（既知リスク）。
    長時間クエリの打ち切り挙動を preview で確認すること
  - 連続リクエスト時に `Cannot perform I/O on behalf of a different request`
    エラーがゼロであること（クライアントのリクエストスコープ管理の検証）

## スコープ外 / 未実施事項

- 旧経路（supabase-js）の削除は Phase 4（#568）で実施する。それまで両経路を維持する。
- Hyperdrive config は**未作成**（上記セットアップはユーザー操作待ち）。
  このコードはフラグ未設定なら Hyperdrive なしで安全にデプロイできる。
