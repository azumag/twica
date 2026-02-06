# コードレビュー結果

**レビュー日**: 2026-02-06
**対象ブランチ**: preview → main
**レビュー対象**: 未コミット変更 (staged) + CLAUDE.md

---

## 🔴 Critical (重大な問題)

### 1. `report*Error` 関数の await 漏れ — **修正済み**

**修正内容**:
- `src/lib/csrf.ts:325` - `await reportSecurityError()` に修正
- `src/lib/realtime.ts:112` - `await reportRealtimeError()` に修正（async関数内）
- `src/lib/realtime.ts:216, 252, 281` - クライアントサイドの同期コールバック内のため `void ... .catch()` パターンで対応
- `src/lib/auth-error-handler.ts` - `handleAuthError` を `async` 化し `await reportAuthError()` に修正

---

### 2. `addCommentToIssue` の失敗を無視 — **修正済み**

**修正内容**: コメント追加失敗時に `throw` するように変更。`markErrorsAsProcessed` がスキップされ、次回の Cron 実行で再試行される。

---

## 🟡 Medium (中程度の問題)

### 3. 環境変数のバリデーション不足 — **修正済み**

**修正内容**: `scheduled` ハンドラの先頭で `GITHUB_REPO_OWNER` と `GITHUB_REPO_NAME` のバリデーションを追加。

---

### 4. ファイル末尾の改行欠如 — **修正済み（既存の staged 変更で対応済み）**

---

### 5. テスト不足

**問題**:
- `src/lib/error-handler.ts` の async 化に伴うテスト更新なし
- `src/lib/sentry/error-handler.ts` の新しい Supabase 連携機能のテストなし
- `workers/error-reporter/src/index.ts` のテストなし

**影響**: リグレッション検出が困難。

**推奨**:
- `error-handler.ts` の各関数が Promise を返すことのテスト
- `error-reporter` Worker の単体テスト（GitHub API モック、Supabase モック）

---

## 🟢 Minor (軽微な問題)

### 6. SENSITIVE_KEYS の不完全なマッチング — **修正済み**

**修正内容**: `access_token`, `refresh_token`, `client_secret`, `api_key`, `credential`, `private_key` を追加。

---

### 7. 文字列切り詰めの重複 — **修正済み**

**修正内容**: マジックナンバーを `MAX_MESSAGE_LENGTH`, `MAX_STACK_LENGTH` 定数に抽出。

---

### 8. CLAUDE.md の末尾の改行処理

**ファイル**: `CLAUDE.md`

`>` 文字は diff の表示上の折り返し表示であり、実際のファイル内容には問題なし。

---

## 📝 コメント・改善提案

### 良い点

1. **エラーシグネチャの重複排除**: `workers/error-reporter/src/index.ts` の `generateSignature` 関数は SHA-256 を使用して同一エラーのグループ化を実現しており、賢明な設計。

2. **機密情報のサニタイズ**: `sanitizeContext` 関数で PII 漏洩防止の配慮が見られる。

3. **部分インデックスの使用**: `supabase/migrations/00012_add_error_tracking.sql` で `WHERE github_issue_created = FALSE` の部分インデックスを使用して効率化。

4. **環境分離**: preview と production で別々の Worker 名 (`twica-error-reporter` / `twica-error-reporter-preview`) を使用しており、環境ごとのエラー分離が適切。

### 改善提案

1. **エラーレポーターのリトライ機構**: GitHub API や Supabase API が一時的に失敗した場合のリトライ処理がない。指数バックオフ付きリトライを検討。

2. **MAX_NEW_ISSUES_PER_RUN の動的調整**: 現在は固定値の 5 だが、GitHub API のレート制限残量に応じて動的に調整する機能を検討。

3. **エラー発生頻度の閾値**: 現在は全ての未処理エラーが対象だが、発生回数が閾値を超えた場合のみ Issue 化する機能を検討（ノイズ削減）。

---

## ✅ チェックリスト（マージ前に対応必須）

- [x] **Critical-1**: `reportSecurityError`, `reportRealtimeError`, `reportAuthError` の呼び出し元に `await` を追加（または非同期対応）
- [x] **Critical-2**: `addCommentToIssue` の失敗時に `markErrorsAsProcessed` が実行されないように修正
- [x] **Medium-3**: `GITHUB_REPO_OWNER` と `GITHUB_REPO_NAME` のバリデーション追加
- [x] **Medium-4**: `src/lib/error-handler.ts` の末尾に改行を追加
- [ ] **Medium-5**: エラーハンドラとエラーレポーターのテスト追加

---

## レビュー実施者

- 自己レビュー
- gemini-cli (タイムアウト)
- codex cli (o3-mini)
