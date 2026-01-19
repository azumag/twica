# CSRF Protection Review Fixes - Retry

## 現在の状況
前回の実装で以下の修正が不足しています：

## 必須の修正（Priority 1）

### 1. src/lib/constants.ts - 定数の追加
**問題:** HTTP_METHODS 定数と DEBUG_MODE 定数が存在しない

**追加するコード:**
```typescript
export const HTTP_METHODS = {
  POST: 'POST',
  PUT: 'PUT',
  DELETE: 'DELETE',
} as const

export const DEBUG_MODE = process.env.NODE_ENV !== 'production'
```

**追加場所:** CSRF_CONFIG 定数の後（約58行目）

### 2. src/lib/csrf.ts - エラーハンドリングの改善
**問題:** エラーログが常に詳細情報を出力している（DEBUG_MODE制御がない）

**変更箇所:** 194-207行目のcatchブロック

**修正前:**
```typescript
} catch (error) {
  if (error instanceof Error && error.name === 'RangeError') {
    logger.info('CSRF validation failed: Buffer length mismatch', {
      userId: session.twitchUserId,
      error: error.message,
    })
  } else {
    logger.error('CSRF validation failed: Unexpected error', {
      userId: session.twitchUserId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,  // 本番環境でスタックトレースが漏洩
    })
  }
  return { valid: false, error: ERROR_MESSAGES.CSRF_TOKEN_INVALID }
}
```

**修正後:**
```typescript
} catch (error) {
  if (DEBUG_MODE) {
    // デバッグモード: 詳細なエラー情報を出力
    if (error instanceof Error && error.name === 'RangeError') {
      logger.info('CSRF validation failed: Buffer length mismatch', {
        userId: session.twitchUserId,
        error: error.message,
      })
    } else {
      logger.error('CSRF validation failed: Unexpected error', {
        userId: session.twitchUserId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      })
    }
  } else {
    // 本番環境: 最小限の情報のみ記録
    logger.warn('CSRF validation failed', {
      userId: session.twitchUserId,
    })
  }
  return { valid: false, error: ERROR_MESSAGES.CSRF_TOKEN_INVALID }
}
```

**インポートの追加:** ファイル先頭のimport文にDEBUG_MODEを追加

### 3. src/lib/middleware/csrf.ts - 定数使用の統一
**問題:** ハードコードされた文字列 'GET', 'POST', 'PUT', 'DELETE' が使用されている

**変更:**
- 14行目: `request.method === 'GET'` → `request.method === HTTP_METHODS.GET` ※HTTP_METHODS.GETを追加
- HTTP_METHODS定数にGETも追加する必要がある

**src/lib/constants.tsのHTTP_METHODSを更新:**
```typescript
export const HTTP_METHODS = {
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  DELETE: 'DELETE',
} as const
```

**src/lib/middleware/csrf.tsのインポートを更新:**
```typescript
import { NextRequest, NextResponse } from 'next/server'
import { validateCSRFToken } from '@/lib/csrf'
import { ERROR_MESSAGES, HTTP_METHODS } from '@/lib/constants'
```

**src/lib/middleware/csrf.tsの更新:**
```typescript
export function withCSRFProtection(
  handler: (request: NextRequest) => Promise<NextResponse>
): (request: NextRequest) => Promise<NextResponse> {
  return async (request: NextRequest): Promise<NextResponse> {
    // GETリクエストは検証なしで通す
    if (request.method === HTTP_METHODS.GET) {
      return handler(request)
    }

    // POST/PUT/DELETEリクエストはCSRFトークンを検証
    const validation = await validateCSRFToken(request)
    if (!validation.valid) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.FORBIDDEN },
        { status: 403 }
      )
    }

    return handler(request)
  }
}
```

### 4. src/lib/csrf.ts - コメントの修正
**問題:** 107行目のコメントが矛盾している

**修正前:**
```typescript
// トークン自体はhttpOnly cookieに保存（XSS対策）
cookieStore.set(COOKIE_NAMES.CSRF_TOKEN, token, {
  httpOnly: false,
```

**修正後:**
```typescript
// トークン自体は非httpOnly cookieに保存（JavaScriptアクセス用）
// 注: XSS攻撃時にトークンが窃取されるリスクがあるが、
// ハッシュ比較によりセッション内のハッシュと照合するため保護される
cookieStore.set(COOKIE_NAMES.CSRF_TOKEN, token, {
  httpOnly: false,
```

### 5. docs/ARCHITECTURE.md - セキュリティ文書の更新
**問題:** XSS + CSRF 組み合わせ攻撃シナリオが文書化されていない

**追加するセクション（アーキテクチャ決定の後に追加）:**

```markdown
### セキュリティ上の考慮事項

#### XSS + CSRF 組み合わせ攻撃シナリオ

**攻撃フロー:**
1. 攻撃者がアプリケーションにXSS脆弱性を注入する
2. 攻撃者のJavaScriptが `document.cookie` 経由で `csrf_token` を読み取る
3. 攻撃者が盗んだトークンを使用してCSRF攻撃を実行

**防御策（二重保護）:**
1. **SameSite='lax'（一次防御）:**
   - クロスサイトPOSTリクエストでCookieが送信されない
   - 最も効果的なCSRF防御レイヤー
   - 古いブラウザ（Safari < 12, IE）では未サポート

2. **CSRFトークン + ハッシュ比較（二次防御）:**
   - セッションにはトークンのハッシュのみを保存（httpOnly cookie）
   - `csrf_token` cookie自体は非httpOnly（JavaScriptアクセス用）
   - XSS攻撃でトークンが盗まれても、ハッシュ比較で検証される
   - トークンの不一致が検知された場合、攻撃として記録

**httpOnly: false が必要な理由:**
- SPA（Single-Page Application）ではJavaScriptからトークンにアクセスする必要がある
- `X-CSRF-Token` ヘッダーにトークンを設定するため
- Cookieからトークンを読み取り、各リクエストに含める
- 設計上の妥協: ユーザビリティとセキュリティのバランス

**結論:**
- SameSite='lax' は一次防御として強力
- CSRFトークンは多層防御として機能
- XSS脆弱性がある場合でも、ハッシュ比較によりCSRF攻撃を防ぐ
```

## 実装手順

1. src/lib/constants.ts:
   - HTTP_METHODS定数（GET, POST, PUT, DELETE）を追加
   - DEBUG_MODE定数を追加

2. src/lib/csrf.ts:
   - DEBUG_MODEをインポート
   - 107行目のコメントを修正
   - 194-207行目のエラーハンドリングをDEBUG_MODE制御に変更

3. src/lib/middleware/csrf.ts:
   - HTTP_METHODSをインポート
   - ハードコードされたHTTPメソッド文字列を定数に置き換え

4. docs/ARCHITECTURE.md:
   - XSS + CSRF 組み合わせ攻撃シナリオを追加
   - httpOnly: false の理由を明記
   - SameSite='lax' の役割を説明

5. docs/IMPLEMENTED.md:
   - 作成（新規ファイル）
   - 修正したファイルの一覧
   - 各修正の詳細
   - セキュリティ向上のポイント

## 検証

実装後、以下を確認：
- `npm run lint` でエラーがないこと
- `npm run test:unit` でテストがパスすること
- すべての定数が適切に使用されていること
- エラーハンドリングがDEBUG_MODEで正しく制御されていること

## 出力

docs/IMPLEMENTED.md に実装記録を作成すること

---
**タスク作成日:** 2026-01-19
**優先度:** Critical
