# 実装済み機能: HttpOnly Cookie PatternによるCSRF保護

## 概要

CSRF保護のためにHttpOnly Cookie Patternを実装しました。当初はDouble Submit Cookie Patternを設計していましたが、実装の過程でHttpOnly Cookie Patternに移行しました。

**採用理由**:
- XSS攻撃時にCSRFトークンが窃取されない
- SameSite='lax'との組み合わせで強固なCSRF保護を提供
- 実装がシンプルでエラーが発生しにくい
- OAuthフローとの互換性を維持

---

## アーキテクチャ

### HttpOnly Cookie Pattern

HttpOnly Cookie Patternでは、CSRFトークンをhttpOnly属性を持つcookieに保存します。JavaScriptからはアクセスできないため、XSS攻撃時にトークンが窃取される心配がありません。

### セッションとcookieの構成

```
Session (httpOnly):
  - CSRFトークンのハッシュ (hash(token))

Cookie (httpOnly):
  - CSRFトークン (token)
  - SameSite='lax'
```

### トークン生成と検証のフロー

**トークン生成**:
1. 暗号論的に安全な乱数でCSRFトークンを生成
2. トークンのハッシュを計算
3. セッションにハッシュを保存
4. httpOnly cookieにトークンを保存

**トークン検証**:
1. Cookieからトークンを取得
2. トークンのハッシュを計算
3. セッションのハッシュと比較

---

## 実装された機能

### 1. CSRFトークン生成 (setCSRFToken)

**ファイル**: `src/lib/csrf.ts:108-109`

```typescript
cookieStore.set(COOKIE_NAMES.CSRF_TOKEN, token, {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
  maxAge: 60 * 60 * 24 * 7, // 7日間
})
```

### 2. CSRFトークン検証 (validateCSRFToken)

**ファイル**: `src/lib/csrf.ts:156`

```typescript
const requestToken = getCSRFTokenFromCookie(cookieStore)
// Cookieからトークンを取得し、ハッシュ比較で検証
```

### 3. 楽観的ロックによる競合状態対策

**ファイル**: `src/lib/csrf.ts:63-90`

- セッションのバージョン管理
- 競合状態を回避するリトライロジック
- 最大リトライ回数の設定

### 4. エラーハンドリング

**ファイル**: `src/lib/csrf.ts:138-207`

- **IPハッシュ化**: ログ出力時にIPアドレスをハッシュ化
- **URLサニタイズ**: ログ出力時にURLをサニタイズ
- ログレベルの適切な使い分け

### 5. timingSafeEqualによるタイミング攻撃対策

**ファイル**: `src/lib/csrf.ts:172-175`

```typescript
crypto.timingSafeEqual(
  Buffer.from(sessionHash),
  Buffer.from(requestTokenHash)
)
```

---

## 変更履歴

### 2026-01-19: Double Submit Cookie Pattern → HttpOnly Cookie Patternへの移行

**理由**:
- 実装の過程でHttpOnly Cookie Patternの方がシンプルで安全であることが判明
- XSS攻撃時にトークンが窃取されないという重要なセキュリティ上の利点

**メリット**:
- XSS攻撃時にCSRFトークンが窃取されない
- SameSite='lax'との組み合わせで強固なCSRF保護
- 実装がシンプルでエラーが発生しにくい
- OAuthフローとの互換性を維持

**デメリット**:
- クライアント側でトークンを操作できない（HttpOnly Cookie Patternとしては正常）
- デバッグ時にトークンを直接確認できない

**変更内容**:
- CSRF_TOKEN cookieをhttpOnly: trueに設定
- X-CSRF-Tokenヘッダーを使用しない（Cookie自動送信）
- `/api/csrf-token`エンドポイントを削除（トークンを返す必要がない）
- `fetchWithCSRF`を削除（HttpOnly Cookie Patternでは不要）

---

## セキュリティ上の考慮事項

### HttpOnly Cookie Patternのメリット

1. **XSS攻撃時にトークンが窃取されない**
   - JavaScriptからアクセスできないため
   - 最も重要なセキュリティ上の利点

2. **SameSite='lax'との組み合わせ**
   - CSRF攻撃を効果的に防止
   - 通常のナビゲーションではcookieが送信される

3. **実装がシンプルでエラーが発生しにくい**
   - ヘッダーの操作不要
   - Cookieの自動送信に頼る

---

## APIルートの修正

### /api/csrf-tokenエンドポイント

**ステータス**: 削除

**理由**:
- HttpOnly Cookie Patternでは、クライアントにトークンを返す必要がない
- JavaScriptからアクセスできないため
- Cookieはブラウザが自動的に送信する

**元の実装**: `src/app/api/csrf-token/route.ts:20-22`

```typescript
// トークンを返していたが、HttpOnly Patternでは不要
return NextResponse.json({ csrfToken: token })
```

---

## クライアント側の実装

### fetchWithCSRFの扱い

**ステータス**: 削除

**理由**:
- HttpOnly Cookie Patternでは、クライアント側で何もする必要がない
- Cookieはブラウザが自動的に送信する
- X-CSRF-Tokenヘッダーを設定する必要がない

**元の実装**: `src/lib/client/csrf.ts:7-12`

```typescript
export async function fetchWithCSRF(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  return fetch(url, options)  // 何もしない！
}
```

**使用方法**:
- 通常の`fetch`を使用してください
- CSRFトークンは自動的にCookieで送信されます

```typescript
// 通常のfetchでOK
const response = await fetch('/api/endpoint', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ data }),
})
```

---

## 関連ファイル

- `src/lib/csrf.ts`: CSRF保護の実装
- `src/lib/constants.ts`: CSRF_CONFIG, COOKIE_NAMES
- `src/app/api/csrf-token/route.ts`: 削除済み
- `src/lib/client/csrf.ts`: 削除済み
- `docs/ARCHITECTURE.md`: 設計書（HttpOnly Cookie Patternに修正済み）
- `docs/REVIEW.md`: レビュー結果

---

## 実装の特徴

### 良い点

1. **型安全**: TypeScriptが適切に使用されている
2. **エラーハンドリング**: 詳細なログとSentry連携
3. **タイミング攻撃対策**: timingSafeEqualの使用
4. **競合状態対策**: 楽観的ロックの実装
5. **情報漏洩対策**: IPハッシュ化とURLサニタイズ

### パフォーマンス

- 楽観的ロックのオーバーヘッドは最小限（通常はリトライされない）
- timingSafeEqualのオーバーヘッドは無視できる
- Cookie操作のオーバーヘッドは標準的

---

## 制限事項

1. **クライアント側でトークンを操作できない**
   - HttpOnly属性によりJavaScriptからアクセスできない
   - これは意図された動作であり、セキュリティ上の利点

2. **デバッグ時にトークンを直接確認できない**
   - ブラウザの開発者ツールでCookieを確認する必要がある

---

## 結論

HttpOnly Cookie PatternによるCSRF保護を実装しました。このパターンはXSS攻撃に対してより安全であり、SameSite='lax'との組み合わせで強固なCSRF保護を提供します。

設計との不一致を解決し、HttpOnly Cookie Patternとして完結させることで、実装をシンプルにし、セキュリティを強化しました。
