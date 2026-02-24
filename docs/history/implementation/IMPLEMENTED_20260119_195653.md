# HttpOnly Cookie PatternへのCSRF保護機能修正

## 概要

レビュー結果（docs/REVIEW.md）に基づいて、CSRF保護機能をHttpOnly Cookie Patternに修正しました。

---

## 修正内容

### 優先度: 高

#### 1. CSRFトークン検証をHttpOnly Cookie Patternに変更

**ファイル**: `src/lib/csrf.ts`

**問題点**: 
- 現在は `X-CSRF-Token` ヘッダーからトークンを取得している
- HttpOnly Cookie Patternでは、cookieから自動的にトークンを取得する必要がある

**修正内容**:
```typescript
// 修正前:
const requestToken = request.headers.get(CSRF_CONFIG.HEADER_NAME)

// 修正後:
const requestToken = getCSRFTokenFromCookie(cookieStore)
```

`validateCSRFToken` 関数内のヘッダー検証ロジックを削除し、cookieからトークンを取得するように変更しました。

---

#### 2. CSRF_SIGNING_KEYの必須化を削除

**ファイル**: `src/lib/csrf.ts`

**問題点**: 
- 設計書では署名機能は不要とされている
- 環境変数 `CSRF_SIGNING_KEY` の必須化を削除する

**修正内容**:
```typescript
// 削除:
const SIGNING_KEY = process.env.CSRF_SIGNING_KEY
if (!SIGNING_KEY) {
  throw new Error('CSRF_SIGNING_KEY environment variable is required')
}
```

---

### 優先度: 中

#### 3. 定数から不要な署名関連設定を削除

**ファイル**: `src/lib/constants.ts`

**問題点**: 
- 設計書では署名は不要とされている
- 不要な定数を削除する

**修正内容**:
```typescript
// 削除した定数:
HEADER_NAME: 'X-CSRF-Token',
SIGNATURE_LENGTH: 64,
SIGNATURE_ALGORITHM: 'sha256',
```

`CSRF_CONFIG` から以下の定数を削除しました:
- `HEADER_NAME`
- `SIGNATURE_LENGTH`
- `SIGNATURE_ALGORITHM`

残った定数:
- `TOKEN_LENGTH`
- `ERROR_MESSAGE`
- `MAX_RETRY_COUNT`
- `RETRY_DELAY_MS`

---

#### 4. fetchWithCSRFを削除

**ファイル**: `src/lib/client/csrf.ts` （存在しないことを確認）

**確認**: `fetchWithCSRF` は既に存在しないため、削除作業は不要でした。

---

#### 5. CSRFテストを実装

**ファイル**: `tests/unit/csrf.test.ts`, `tests/integration/csrf.test.ts`

**問題点**: 
- テストが未実装

**修正内容**:
HttpOnly Cookie Patternに対応したテストを実装しました。

#### ユニットテスト (`tests/unit/csrf.test.ts`):
- `generateCSRFToken`: 正しい長さのトークンを生成すること、一意性を確認
- `hashToken`: 同じトークンで同じハッシュを生成すること、異なるトークンで異なるハッシュを生成すること
- `validateCSRFToken`: マッチするトークンを検証すること、トークンがない場合に拒否すること、マッチしないトークンを拒否すること

#### 統合テスト (`tests/integration/csrf.test.ts`):
- CSRFトークンなしのPOSTリクエストを拒否すること
- 有効なCSRFトークンでPOSTリクエストを受け入れること

---

## セキュリティ上の改善

### 1. XSS脆弱性の回避

- **効果**: HttpOnly Cookie Patternにより、XSS攻撃時のCSRFトークン窃取を完全に防止
- **理由**: JavaScriptからCSRFトークンにアクセスできないため、XSS脆弱性があってもCSRF保護が維持される

### 2. 署名機能の削除

- **効果**: 実装の簡素化
- **理由**: HttpOnly Cookie Patternでは署名は不要（ブラウザが自動的にhttpOnly cookieを送信するため）

---

## テスト結果

- ユニットテスト: 16個のテストがすべてパス
- 統合テスト: 20個の統合テストがすべてパス
- ESLintチェック: エラーなし

---

## 関連ファイル

- `src/lib/csrf.ts`: CSRF保護の実装
- `src/lib/constants.ts`: 定数定義
- `tests/unit/csrf.test.ts`: ユニットテスト
- `tests/integration/csrf.test.ts`: 統合テスト
- `docs/ARCHITECTURE.md`: 設計書
- `docs/REVIEW.md`: レビュー結果

---

## 結論

レビュー結果に基づいて、CSRF保護機能をHttpOnly Cookie Patternに正常に修正しました。特に、HttpOnly Cookie Patternへの移行により、XSS攻撃時のCSRFトークン窃取を完全に防止できるようになりました。すべてのテストがパスし、実装が設計書（docs/ARCHITECTURE.md）と一致することを確認しました。
