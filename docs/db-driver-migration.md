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

> **注意**: `GACHA_DB_DRIVER=pg` を `DB_DRIVER` 未設定のまま先行して立てる場合も
> Hyperdrive（または `DATABASE_URL`）の設定が前提（未設定だと該当経路が接続エラーで失敗する）。

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
   -- BYPASSRLS の明示付与が必須。一部テーブル（storage_usage / blob_files /
   -- errors / support_codes / user_licenses）の RLS ポリシーは JWT クレーム述語
   -- （00006/00012 の auth.jwt() ->> 'role'、00017 の auth.role()）で書かれており、
   -- PostgREST の JWT クレームを持たない pg 直結では述語が常に偽になる
   -- （update_storage_usage / activate_support_code / deactivate_all_licenses は
   --  SECURITY INVOKER のため関数経由でも同じ）。service_role 自体は BYPASSRLS
   -- 属性を持つが、ロール属性はメンバーシップ（grant service_role to twica_app）
   -- では継承されない（PostgreSQL の仕様）ため、明示的に付与して既存 PostgREST
   -- service-role アクセス（JWT で role=service_role を主張し全ポリシーを通過）と
   -- 同等にする。BYPASSRLS を付けても superuser にはならず、GRANT された DML
   -- 権限の範囲でのみ操作可能。
   alter role twica_app bypassrls;
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

Hyperdrive に設定する接続は Postgres ロール直結であり、PostgREST の JWT クレームを
持たない。`grant service_role to twica_app` による GRANT（DML 権限）と
「FOR ALL TO service_role」形式の RLS ポリシーの継承だけでは、JWT クレーム述語
（`auth.jwt()` / `auth.role()`）で書かれた RLS ポリシー（storage_usage / blob_files /
errors / support_codes / user_licenses）を通過できない。セットアップ手順 1 の
`alter role twica_app bypassrls;` を付与して**初めて**、既存の PostgREST 経由の
service-role アクセス（JWT で role=service_role を主張し全ポリシーを通過する＝
実質 RLS の外側）と同等になる、という構造である。同等化後の防壁はこれまでどおり
アプリ層の認可のみ。なお BYPASSRLS は superuser 化ではなく、GRANT された DML
権限の範囲でのみ操作可能であることに変わりはない。

## 切替運用

env 変更はビルド不要で秒単位で反映される（Cloudflare では新デプロイ扱い）。
ロールバックは env を戻すだけ。必ず以下の順で行う:

1. フラグ未設定でマージ・デプロイ（挙動不変を確認）
2. preview に `DB_DRIVER=pg-read` → 検証 → `DB_DRIVER=pg` → 検証
3. prod で同順（pg-read → 検証 → pg）
4. 問題発生時: env を戻す（ガチャ経路のみ戻す場合は `GACHA_DB_DRIVER=postgrest`）

（推奨）ガチャ経路はチャネルポイント消費を伴う課金系クリティカルパスのため段階
切替する: `DB_DRIVER=pg` にする前に `GACHA_DB_DRIVER=postgrest` を明示設定して
ガチャ経路だけ旧経路に固定し、他経路の検証完了後に `GACHA_DB_DRIVER=pg`
（または未設定に戻す）でガチャを単独切替・検証する。

## 検証

- 切替前: `scripts/verify-db-schema.js` を preview / prod それぞれの
  `DATABASE_URL` で実行し、schema.ts と実 DB の差分ゼロを確認する。
  あわせて同スクリプトが接続ロールで全テーブルへ SELECT スモーククエリを発行し、
  権限エラー（GRANT 不足）を failure、0 行（RLS 断絶の可能性）を警告として報告する
  （DB 接続が必要なため CI では実行しない）:
  ```bash
  DATABASE_URL="<Direct connection 文字列>" node scripts/verify-db-schema.js
  ```
- 切替後: `wrangler tail` で `[db:pg]` タグのエラーと `CONNECTION_*` 系エラーを監視する。
- 自動 smoke-check（15分毎）は pg 経路のエンドポイントを踏まない（`/` と `/plans` の
  HTTP チェックと supabase-js 経由のスキーマチェックのみ）ため、切替直後は
  `wrangler tail` での手動監視を最低30分継続すること。
- ユニットテスト（parity テスト群）は実 DB・実ドライバを経由しないモック比較であり、
  両経路のモックに同じ誤った前提を書くと検出できない（例: 日付文字列の形式差
  — pg 直結の PG テキスト形式 vs PostgREST の ISO 8601 — はモックでは再現して
  いない）。preview での実機確認が実 DB に対する唯一の検証機会である。
- preview で `DB_DRIVER=pg-read` にした際、ダッシュボードのお知らせバナー表示
  （パイロット経路 `getUnreadAnnouncements`）が postgrest 時と同一であることを
  目視確認する（日付シリアライズ差の実機確認を兼ねる）。
- preview での確認項目:
  - `statement_timeout` が Hyperdrive を透過するか未確認（既知リスク）。
    長時間クエリの打ち切り挙動を preview で確認すること
  - 連続リクエスト時に `Cannot perform I/O on behalf of a different request`
    エラーがゼロであること（クライアントのリクエストスコープ管理の検証）
  - ガチャを実際に1回引いてカードが付与され、overlay 演出・チャット通知が出ること
    （EventSub 経由。可能なら重複再送・上限付きカードの再抽選も確認する）
  - ダッシュボードの主要タブ（カード一覧・ガチャ履歴・統計・カード別所持統計・
    ガチャユーザー一覧）が postgrest 時と同一表示になること
  - Twitch トークンリフレッシュ（時間経過後のダッシュボード操作）と
    BOT アカウント経由のチャット送信が動くこと
  - 支援コードの有効化・解除が動作すること（support_codes / user_licenses は
    JWT クレーム述語の RLS で守られており、BYPASSRLS 未付与の断絶はここで顕在化する）
  - 運用注意（サポート対応）: 支援コード有効化の失敗申告を受けた場合、再試行を
    案内する前に user_licenses と support_codes.activation_count を確認する
    （接続断で「実際には有効化済みだが失敗表示」になるケースがあるため）
  - 画像アップロード / 削除で storage_usage の使用量が増減すること
    （storage_usage / blob_files も同様に JWT クレーム述語の RLS 対象）
  - Supabase の max-rows 設定値（API 設定）が既定 1000 のままか確認すること。
    変更している場合は `src/lib/dashboard-data.ts` の明示 LIMIT 群
    （コメントで max-rows を参照している箇所）を実値に合わせる

## スコープ外 / 未実施事項

- 旧経路（supabase-js）の削除は Phase 4（#568）で実施する。それまで両経路を維持する。
- Hyperdrive config は**未作成**（上記セットアップはユーザー操作待ち）。
  このコードはフラグ未設定なら Hyperdrive なしで安全にデプロイできる。
- 既知の稀な事象: 接続断リトライ後の再実行で、発行上限付きカードの場合に
  limit_reached が event_id 重複チェックより先に評価され
  （`execute_gacha_transaction` の評価順序、migration 00070）、結果として
  演出・通知が欠落することがある（カード付与とポイント消費は正しく1回のみで、
  データ不整合はない）。ログの
  `[db:pg] gacha rpc returned ... after connection retry` で観測可能。
  Phase 2 で plpgsql の重複チェックを上限チェックより先に移す migration を
  提案する（#568）。
