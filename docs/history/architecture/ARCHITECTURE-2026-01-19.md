# Issue #55: Critical Security - Missing CSRF Protection on State-Changing API Routes

## 概要

アプリケーションは現在セッションベースの認証のみを使用しており、CSRF（Cross-Site Request Forgery）保護が実装されていません。これにより、すべての状態変更操作がCSRF攻撃に対して脆弱です。

## 問題分析

### 現在の実装

現在のセッション管理（`src/lib/session.ts`, `src/app/api/auth/twitch/callback/route.ts`）:

```typescript
// OAuth callbackでセッションクッキーを設定
cookieStore.set(COOKIE_NAMES.SESSION, sessionData, {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',  // SameSite='lax' blocks cross-site POST requests (primary CSRF defense)
  path: '/',
  maxAge: SESSION_CONFIG.MAX_AGE_SECONDS,
})
```

**SameSite='lax'による保護:**

SameSite='lax'はCSRF攻撃に対する効果的な一次防御レイヤーです：
- ✓ クロスサイトPOSTリクエストでCookieが送信されない
- ✓ OAuthコールバックを含むトップレベルナビゲーションは許可
- ✗ 古いブラウザでは未サポート（Safari < 12, IE）

**防御の深層化:**

SameSite='lax' + CSRFトークンで多層防御を実現：
- SameSite='lax': ブラウザレベルでのクロスサイトPOST阻止
- CSRFトークン: カスタムヘッダーによる追加検証（XSS対策としても機能）

**問題点:**

1. **CSRFトークンの欠如**:
   - すべてのPOST/PUT/DELETE APIルートはセッションクッキーのみで認証
   - カスタムヘッダーの検証がない
   - リクエストのオリジンを検証していない

2. **影響を受けるエンドポイント**:
   - `/api/upload` - ファイルアップロード
   - `/api/cards` - カード作成/更新/削除
   - `/api/gacha` - ガチャ実行
   - `/api/battle/start` - バトル開始
   - `/api/streamer/settings` - 配信者設定
   - `/api/user-cards` - ユーザーカード管理

### 攻撃シナリオ

攻撃者が以下のような悪意のあるサイトを作成できます:

```html
<!-- 攻撃者のサイト -->
<form action="https://twica.app/api/battle/start" method="POST">
  <input type="hidden" name="userCardId" value="victim-card-id">
  <button>Click to win prize!</button>
</form>

<script>
  // 自動送信
  document.forms[0].submit();
</script>
```

SameSite='lax'の保護機能:
- クロスサイトPOSTリクエストではCookieが送信されないため、この攻撃はブロックされる
- CSRFトークン検証により追加の保護レイヤーが提供される
- 攻撃者の意図しないバトル実行は防止される

## 機能要件

1. **CSRFトークン生成**:
   - ユーザーごとにユニークなCSRFトークンを生成
   - トークンのハッシュをセッションに保存
   - 暗号学的に安全な乱数を使用

2. **CSRFトークン配布**:
   - トークンのハッシュをセッションに保存（httpOnly cookie）
   - トークン自体もhttpOnly cookieに保存（JavaScriptからアクセス不可）
   - ブラウザが自動的にトークンをリクエストに含める

3. **CSRFトークン検証**:
   - すべてのPOST/PUT/DELETEリクエストでトークンを検証
   - cookieからトークンを取得し、ハッシュ比較で検証
   - トークン不一致の場合は403エラーを返す

4. **セキュアなトークン管理**:
   - セッションごとに一意のトークン
   - トークンの有効期限を管理
   - ログアウト時にトークンを無効化

## 非機能要件

1. **セキュリティ**:
   - 暗号学的に強力な乱数生成器を使用
   - トークン推測攻撃を防ぐため、十分なエントロピーを持つ
   - タイミング攻撃に対して安全な比較
   - トークンのハッシュをセッションに保存（トークン値の漏洩防止）

2. **可用性**:
   - 既存のOAuthフローを維持
   - すべての正当なリクエストが正常に動作
   - エラーメッセージは攻撃者に情報を漏らさない

3. **パフォーマンス**:
   - トークン検証のオーバーヘッドを最小化
   - キャッシュ戦略を検討（ただし、セキュリティを優先）

4. **可観測性**:
   - CSRF検証エラーをloggerとSentryに詳細に記録
   - 不審なリクエストパターンを検知

## 受け入れ基準

1. **CSRF保護の実装**:
    - すべてのPOST/PUT/DELETE APIルートでCSRFトークン検証が行われる
    - トークンのハッシュがセッションに正しく保存される
    - トークンがhttpOnly cookieに保存され、JavaScriptからアクセス不可

2. **セキュリティ**:
   - CSRF攻撃が防止されることをテストで検証
   - トークンが推測不可能であること
   - トークン不一致が適切に検知される
   - XSS攻撃時にトークンが窃取されても、ハッシュ比較で検証される

3. **既存機能の互換性**:
   - OAuthフローが正常に動作
   - すべての機能がCSRF保護下で動作
   - エラーメッセージが適切

4. **テスト**:
   - CSRF保護のユニットテストが存在
   - 統合テストがパス
   - 手動テストでCSRF攻撃が防止されることを確認

## 設計方針

### アーキテクチャ決定

**選択: HttpOnly Cookie Pattern**

選定理由:
1. XSS攻撃時にCSRFトークンが窃取されないため、より安全
2. 実装がシンプルでエラーが発生しにくい
3. SameSite='lax'との組み合わせで強固なCSRF保護が実現できる
4. クライアント側での追加実装が不要
5. OAuthフローとの完全な互換性

### アーキテクチャ図

```
┌─────────────────────────────────────────────────────┐
│  Server Side (Session - httpOnly, secure)          │
│  ┌──────────────────────────────────────────────┐  │
│  │ {                                             │  │
│  │   twitchUserId: "xxx",                       │  │
│  │   csrfTokenHash: "a1b2c3...",                  │  │
│  │   version: 5,                                 │  │
│  │ }                                             │  │
│  └──────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│  Client Side (csrf_token Cookie - httpOnly)       │
│  ┌──────────────────────────────────────────────┐  │
│  │ csrf_token: "d4e5f6..." (JavaScriptからアクセス不可) │  │
│  └──────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘

Request Flow:
1. Browser automatically sends httpOnly csrf_token cookie with requests
2. Server reads token from cookie, hashes it, and compares with session.csrfTokenHash
3. No client-side token handling required
4. On token generation, optimistic locking prevents race conditions
```

### 競合状態対策（楽観的ロック）

セッションにバージョン番号を追加し、トークン生成時にバージョンを検証することで、複数の同時リクエストによる競合状態を回避します。

**実装仕様**:
- セッションの読み取りと更新の間でバージョンを確認
- バージョンが不一致の場合、リトライ（最大3回、10ms間隔）
- 更新成功時にバージョンをインクリメント
- リトライ回数超過時はエラーをスロー

### セキュリティ配慮のあるログ記録

エラーログには以下の処理を適用し、情報漏洩を防止します：
- IPアドレスのSHA-256ハッシュ化（先頭8文字のみ）
- エンドポイントURLのサニタイズ（パスのみ）
- タイムスタンプのISO 8601形式記録
- ユーザーIDの記録（デバッグ用）

### コンポーネント設計

#### 1. CSRFトークン管理モジュール

**新規ファイル**: `src/lib/csrf.ts`

```typescript
import { cookies } from 'next/headers'
import { crypto } from 'node:crypto'
import { logger } from './logger'
import { reportSecurityError } from './sentry/error-handler'
import { COOKIE_NAMES } from './constants'
import { parseSession } from './session'

const CSRF_TOKEN_LENGTH = 32 // 256 bits
// HttpOnly Cookie Patternではヘッダーは不要
const CSRF_ERROR_MESSAGE = 'Invalid CSRF token'

/**
 * CSRFトークンを生成
 */
function generateCSRFToken(): string {
  return crypto.randomBytes(CSRF_TOKEN_LENGTH).toString('hex')
}

/**
 * トークンのハッシュを生成（SHA-256）
 */
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

/**
 * セッションにCSRFトークンのハッシュを保存し、トークン自体もhttpOnly cookieに保存
 */
export async function setCSRFToken(): Promise<string> {
  const cookieStore = await cookies()

  const sessionCookie = cookieStore.get(COOKIE_NAMES.SESSION)?.value
  if (!sessionCookie) {
    throw new Error('No session found')
  }

  const session = parseSession(sessionCookie)
  const userId = session.twitchUserId

  // Idempotent: 既にトークンが存在する場合は返す
  if (session.csrfTokenHash) {
    // トークン自体はcookieから取得して返す（存在する場合）
    const existingToken = getCSRFTokenFromCookie(cookieStore)
    if (existingToken) {
      return existingToken
    }
  }

  // 新しいトークンを生成
  const token = generateCSRFToken()
  const tokenHash = hashToken(token)

  // セッションにハッシュを保存（httpOnly）
  const updatedSession = {
    ...session,
    csrfTokenHash: tokenHash,
  }

  cookieStore.set(COOKIE_NAMES.SESSION, JSON.stringify(updatedSession), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_CONFIG.MAX_AGE_SECONDS,
  })

  // トークン自体もhttpOnly cookieに保存（JavaScriptからアクセス不可）
  cookieStore.set('csrf_token', token, {
    httpOnly: true, // HttpOnly Cookie Pattern
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_CONFIG.MAX_AGE_SECONDS,
  })

  logger.info(`CSRF token generated for user ${userId}`)
  return token
}

/**
 * CookieからCSRFトークンを取得
 */
function getCSRFTokenFromCookie(cookieStore: Awaited<ReturnType<typeof cookies>>): string | null {
  const tokenCookie = cookieStore.get('csrf_token')?.value
  return tokenCookie || null
}

/**
 * CSRFトークンを検証（ハッシュ比較）
 */
export async function validateCSRFToken(
  request: Request
): Promise<{ valid: boolean; error?: string }> {
  const cookieStore = await cookies()
  const sessionCookie = cookieStore.get(COOKIE_NAMES.SESSION)?.value

  if (!sessionCookie) {
    logger.warn('CSRF validation failed: No session found', {
      ip: request.headers.get('x-forwarded-for'),
      userAgent: request.headers.get('user-agent'),
    })
    return { valid: false, error: ERROR_MESSAGES.CSRF_TOKEN_INVALID }
  }

  const session = parseSession(sessionCookie)
  const sessionTokenHash = session.csrfTokenHash

  if (!sessionTokenHash) {
    logger.warn('CSRF validation failed: No CSRF token in session', {
      userId: session.twitchUserId,
    })
    return { valid: false, error: ERROR_MESSAGES.CSRF_TOKEN_INVALID }
  }

  const requestToken = getCSRFTokenFromCookie(cookieStore)

  if (!requestToken) {
    logger.warn('CSRF validation failed: CSRF token missing in cookie', {
      userId: session.twitchUserId,
      endpoint: request.url,
    })
    return { valid: false, error: ERROR_MESSAGES.CSRF_TOKEN_INVALID }
  }

  // ハッシュを比較（トークン値の漏洩を防止）
  const requestTokenHash = hashToken(requestToken)

  try {
    const isValid = crypto.timingSafeEqual(
      Buffer.from(sessionTokenHash),
      Buffer.from(requestTokenHash)
    )

    if (!isValid) {
      logger.warn('CSRF token validation failed: Token mismatch (potential attack)', {
        userId: session.twitchUserId,
        ip: request.headers.get('x-forwarded-for'),
        referer: request.headers.get('referer'),
        endpoint: request.url,
      })

      reportSecurityError(new Error('CSRF token mismatch'), {
        action: 'csrf_validation',
        userId: session.twitchUserId,
      })

      return { valid: false, error: ERROR_MESSAGES.CSRF_TOKEN_INVALID }
    }

    return { valid: true }
  } catch (error) {
    // timingSafeEqualはバッファ長不一致でエラーをスロー
    logger.warn('CSRF validation failed: Hash comparison error', {
      userId: session.twitchUserId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { valid: false, error: ERROR_MESSAGES.CSRF_TOKEN_INVALID }
  }
}

/**
 * CSRFトークンをクリア
 */
export async function clearCSRFToken(): Promise<void> {
  const cookieStore = await cookies()
  const sessionCookie = cookieStore.get(COOKIE_NAMES.SESSION)?.value

  if (sessionCookie) {
    const session = parseSession(sessionCookie)

    // セッションからハッシュを削除
    const updatedSession = { ...session }
    delete updatedSession.csrfTokenHash

    cookieStore.set(COOKIE_NAMES.SESSION, JSON.stringify(updatedSession), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_CONFIG.MAX_AGE_SECONDS,
    })
  }

  // CSRFトークンクッキーを削除
  cookieStore.delete('csrf_token')

  logger.info('CSRF token cleared')
}
```

#### 2. CSRFトークン取得APIエンドポイント

**HttpOnly Cookie Patternでは不要**

HttpOnly Cookie Patternでは、トークンがhttpOnly cookieに保存されるため、クライアントにトークンを返すAPIは不要です。

- トークンはcookie経由で自動的に送信されます
- JavaScriptからトークンにアクセスする必要がありません
- APIエンドポイントは削除します

#### 3. CSRF検証ミドルウェア

**新規ファイル**: `src/lib/middleware/csrf.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { validateCSRFToken } from '@/lib/csrf'
import { ERROR_MESSAGES } from '@/lib/constants'

/**
 * CSRFトークンを検証するミドルウェア
 * POST/PUT/DELETEリクエストに対して適用
 */
export async function withCSRFProtection(
  handler: (request: NextRequest) => Promise<NextResponse>
): Promise<NextResponse> {
  return async (request: NextRequest) => {
    const method = request.method.toUpperCase()

    // POST/PUT/DELETEのみ検証
    if (['POST', 'PUT', 'DELETE'].includes(method)) {
      const validation = await validateCSRFToken(request)

      if (!validation.valid) {
        return NextResponse.json(
          { error: ERROR_MESSAGES.FORBIDDEN },
          { status: 403 }
        )
      }
    }

    return handler(request)
  }
}
```

#### 4. APIルートの修正例

**修正ファイル**: `src/app/api/gacha/route.ts`

```typescript
import { NextRequest, NextResponse } from "next/server";
import { validateCSRFToken } from "@/lib/csrf"; // 追加

export async function POST(request: NextRequest) {
  // CSRF検証を追加
  const validation = await validateCSRFToken(request);
  if (!validation.valid) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.FORBIDDEN },
      { status: 403 }
    );
  }

  // 既存の実装...
  const gachaService = new GachaService();
  const result = await gachaService.executeGacha(streamerId, session.twitchUserId, session.twitchUsername);

  return NextResponse.json<GachaSuccessResponse>({
    card: result.data.card
  });
}
```

#### 5. クライアント側の実装

** HttpOnly Cookie Patternでは不要**

HttpOnly Cookie Patternでは、CSRFトークンがhttpOnly cookieに保存されるため、クライアント側での実装は不要です。

- トークンはブラウザによって自動的に送信されます
- JavaScriptからトークンにアクセスする必要がありません
- 通常のfetch呼び出しでCSRF保護が自動的に適用されます

```typescript
// 通常のfetch呼び出しでOK
const response = await fetch('/api/cards', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(cardData),
})
```

### 定数の追加

**修正ファイル**: `src/lib/constants.ts`

```typescript
export const CSRF_CONFIG = {
  TOKEN_LENGTH: 32,
  ERROR_MESSAGE: 'Invalid CSRF token',
  MAX_RETRY_COUNT: 3,      // 楽観的ロックの最大リトライ回数
  RETRY_DELAY_MS: 10,       // リトライ遅延（ミリ秒）
} as const

export const SESSION_CONFIG = {
  MAX_AGE_SECONDS: 7 * 24 * 60 * 60, // 7 days
} as const

export const COOKIE_NAMES = {
  SESSION: 'twica_session',
  AUTH_STATE: 'twitch_auth_state',
  CSRF_TOKEN: 'csrf_token', // httpOnly cookie - JavaScriptからアクセス不可
}
```

### エラーメッセージの追加

**修正ファイル**: `src/lib/constants.ts`

```typescript
export const ERROR_MESSAGES = {
  // 既存のエラーメッセージ...
  FORBIDDEN: 'Forbidden',
  // CSRFエラーを追加
  CSRF_TOKEN_INVALID: 'Invalid or missing CSRF token',
} as const
```

### トレードオフ

#### メリット

1. **セキュリティ向上**:
   - CSRF攻撃を効果的に防止
   - ユーザーの不正利用を防ぐ
   - OWASP推奨のベストプラクティスに準拠
   - XSS攻撃時にトークンが窃取されても、ハッシュ比較で保護
   - 詳細なログ記録で監査・デバッグが容易

2. **実装の簡潔さ**:
   - 追加のデータベースが不要
   - 既存のセッション構造を利用
   - クライアント側の実装が簡単

3. **OAuthフローとの互換性**:
   - SameSite='lax'を維持
   - OAuthコールバックが正常に動作

#### デメリット

1. **セッションサイズの増加**:
   - CSRFトークンのハッシュがセッションに含まれるため、サイズが増加
   - 64文字（SHA-256 hex）の追加

2. **追加のCookie**:
   - httpOnly cookieが1つ追加される
   - Cookieサイズの増加（最小限）

3. **トークン更新ロジック**:
   - セッション更新時にトークンも更新する必要がある
   - ログアウト時にトークンを無効化

### リスク

1. **実装ミスのリスク**:
   - 一部のAPIルートで検証を忘れる可能性
   - 回避策: ESLintルールやTypeScriptのデコレータで強制

2. **パフォーマンスへの影響**:
   - すべてのリクエストでトークン検証が追加される
   - 回避策: キャッシュ戦略の検討（ただし、セキュリティを優先）

3. **クライアント側の複雑性**:
   - HttpOnly Cookie Patternではクライアント側の実装が不要
   - 回避策: 開発者ドキュメントで通常のfetch使用を明記

4. **XSS脆弱性との組み合わせ**:
   - HttpOnly CookieによりXSS攻撃時でもCSRFトークンが窃取されない
   - 回避策: httpOnly cookie設定によりJavaScriptからのアクセスを完全にブロック

### テスト計画

#### ユニットテスト

**新規ファイル**: `tests/unit/csrf.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generateCSRFToken, validateCSRFToken, hashToken } from '@/lib/csrf'

describe('CSRF Protection', () => {
  describe('generateCSRFToken', () => {
    it('should generate a token of correct length', () => {
      const token = generateCSRFToken()
      expect(token).toHaveLength(64) // 32 bytes * 2 (hex)
    })

    it('should generate unique tokens', () => {
      const token1 = generateCSRFToken()
      const token2 = generateCSRFToken()
      expect(token1).not.toBe(token2)
    })
  })

  describe('hashToken', () => {
    it('should generate consistent hashes', () => {
      const token = 'test-token'
      const hash1 = hashToken(token)
      const hash2 = hashToken(token)
      expect(hash1).toBe(hash2)
    })

    it('should generate different hashes for different tokens', () => {
      const hash1 = hashToken('token1')
      const hash2 = hashToken('token2')
      expect(hash1).not.toBe(hash2)
    })
  })

describe('validateCSRFToken', () => {
  it('should validate matching tokens', async () => {
    const token = generateCSRFToken()
    // Mock request with matching token in cookie
    const request = new Request('https://example.com', {
      headers: { 'Cookie': `csrf_token=${token}` }
    })
    const result = await validateCSRFToken(request)
    expect(result.valid).toBe(true)
  })

  it('should reject missing token', async () => {
    const request = new Request('https://example.com')
    const result = await validateCSRFToken(request)
    expect(result.valid).toBe(false)
  })

  it('should reject mismatched tokens', async () => {
    const request = new Request('https://example.com', {
      headers: { 'Cookie': 'csrf_token=wrong-token' }
    })
    const result = await validateCSRFToken(request)
    expect(result.valid).toBe(false)
  })
})
})
```

#### 統合テスト

**新規ファイル**: `tests/integration/csrf.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from 'http'

describe('CSRF Integration Tests', () => {
  it('should reject POST request without CSRF token', async () => {
    const response = await fetch('http://localhost:3000/api/gacha', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ streamerId: 'test' }),
    })

    expect(response.status).toBe(403)
  })

  it('should accept POST request with valid CSRF token', async () => {
    // HttpOnly Cookie Patternでは、cookie経由でトークンが自動的に送信されます
    // アプリ内からの通常のリクエストは、cookieにcsrf_tokenが含まれていれば成功します

    // 1. 最初にセッションを作成し、トークンを生成（アプリ内からのリクエストを想定）
    // 実際のテストでは、セッション初期化フローを実行する必要があります

    // 2. cookie付きでリクエストを送信（ブラウザが自動的にcookieを含める）
    const response = await fetch('http://localhost:3000/api/gacha', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Cookieはブラウザによって自動的に含まれるため、手動で設定する必要はありません
      },
      body: JSON.stringify({ streamerId: 'test' }),
      credentials: 'include', // cookieを含めるように設定
    })

    // 認証エラーなど、CSRF以外のエラーが返るはず
    expect(response.status).not.toBe(403)
  })
})
```

#### 手動テスト

1. **CSRF攻撃のシミュレーション**:
   - 外部サイトからPOSTリクエストを送信
   - 403エラーが返ることを確認

2. **正当なリクエスト**:
   - アプリ内から正常にリクエストが送信できることを確認
   - CSRFトークンが正しく含まれていることを確認

3. **トークンの有効期限**:
   - セッション切れ後に古いトークンでリクエストを送信
   - 403エラーが返ることを確認

## 実装ステップ

### Phase 1: 基礎コンポーネントの実装
1. `src/lib/csrf.ts` - CSRFトークン管理モジュールの実装（HttpOnly Cookie Pattern）
2. `src/lib/constants.ts` - 定数の追加
3. ユニットテストの実装

### Phase 2: APIルートの保護
1. `src/lib/middleware/csrf.ts` - CSRF検証ミドルウェアの実装
2. すべてのPOST/PUT/DELETE APIルートにCSRF検証を追加
3. エラーハンドリングの統合

### Phase 3: クライアント側の実装
1. HttpOnly Cookie Patternではクライアント側の実装は不要
2. 通常のfetch呼び出しでCSRF保護が自動的に適用される
3. fetchWithCSRFは不要となるため削除

### Phase 4: テストとドキュメント
1. 統合テストの実装
2. 手動テストの実施
3. ドキュメントの更新

## 変更履歴

### 2026-01-19 - HttpOnly Cookie Patternへの変更

**理由**: レビューで指摘された設計と実装の不一致を解決し、セキュリティを強化

**変更内容**:
- セッションにはCSRFトークンのハッシュを保存（httpOnly）
- CSRFトークン自体もhttpOnly cookieに保存（JavaScriptからアクセス不可）
- ブラウザが自動的にトークンをリクエストに含める
- X-CSRF-Tokenヘッダーは不要
- fetchWithCSRFは不要

**メリット**:
- XSS攻撃時にCSRFトークンが窃取されないため、より安全
- 実装がシンプルでエラーが発生しにくい
- クライアント側の実装が不要

**デメリット**:
- Cookieが1つ追加される（最小限のオーバーヘッド）

### 2026-01-19 - SameSite='lax'の説明を修正

**理由**: 設計書でSameSite='lax'を「⚠️ CSRF脆弱性」として説明していたが、これは誤り

**変更内容**:
- SameSite='lax'はCSRF攻撃に対する効果的な一次防御レイヤーであることを明記
- CSRFトークンは多層防御として機能することを説明

### 2026-01-19 - エラーハンドリングの改善

**理由**: セキュリティとデバッグ性のバランスを改善

**変更内容**:
- クライアントへのエラーメッセージは汎用的に（ERROR_MESSAGES.CSRF_TOKEN_INVALID）
- ログメッセージは詳細に（検証失敗の理由、IP、ユーザーIDなど）

### 2026-01-19 - 楽観的ロックの実装

**理由**: セッション更新時の競合状態を回避

**変更内容**:
- セッションにバージョン番号を追加
- トークン生成時にバージョンを検証
- バージョンが不一致の場合、リトライ（最大3回、10ms間隔）
- 更新成功時にバージョンをインクリメント

### 2026-01-19 - セキュリティ配慮のあるログ記録

**理由**: エラーログからの情報漏洩を防止

**変更内容**:
- IPアドレスのSHA-256ハッシュ化（先頭8文字のみ）
- エンドポイントURLのサニタイズ（パスのみ）
- タイムスタンプのISO 8601形式記録
- ユーザーIDの記録（デバッグ用）

## 推奨される実装順序

### 優先度1: SameSite属性の修正
- **影響範囲**: 小
- **リスク**: なし
- **説明**: CSRFトークンcookieのsameSite属性を'lax'に変更するだけで、OAuthコールバックが正常に動作するようになる

### 優先度2: HttpOnly Cookieパターンへの移行
- **影響範囲**: 中
- **リスク**: 中
- **説明**: CSRFトークンをhttpOnly cookieに保存し、X-CSRF-Tokenヘッダーを削除する。これにより、XSS脆弱性がある場合でもCSRFトークンが窃取されないようになる

### 優先度3: 楽観的ロックの実装
- **影響範囲**: 小
- **リスク**: 低
- **説明**: セッションにバージョン番号を追加し、トークン生成時に競合状態を回避する
- **ステータス**: ✅ 実装済み

### 優先度4: エラーハンドリングの改善
- **影響範囲**: 小
- **リスク**: なし
- **説明**: エラーの種類に応じて異なるログレベルを使用する
- **ステータス**: ✅ 実装済み（IPハッシュ化、URLサニタイズ）

---

## レビュー結果に基づく設計修正

### 2026-01-19 - レビュー結果に基づくセキュリティ改善

**理由:** docs/REVIEW.md で指摘された以下の問題に対処する
- XSS脆弱性によりCSRF保護が完全に無効化されるリスク
- SameSite='strict'によるOAuthコールバック失敗のリスク
- トークン生成の競合状態
- エラーハンドリングの改善

---

## Q1: XSS脆弱性とCSRF保護の共存

### 選択したアプローチ: HttpOnly Cookie Pattern

HttpOnly Cookie Patternを採用し、XSS攻撃時のトークン窃取を完全に防ぎます。

### 理由

1. **XSS攻撃に対する強固な保護**
   - HttpOnly cookieによりJavaScriptからのアクセスを完全にブロック
   - CSRFトークンが窃取される可能性がない

2. **SameSite='lax'による一次防御**
   - 既に実装済み
   - CSRF攻撃の大部分を防ぐ

3. **ハッシュ比較によるセキュリティ強化**
   - トークン値の漏洩を防ぐ
   - セッションにはハッシュのみを保存

4. **OAuthフローとの互換性**
   - SameSite='lax'でOAuthコールバックが正常に動作

5. **実装の簡潔さ**
   - クライアント側の実装が不要
   - 追加のインフラが不要

### トレードオフ

**メリット:**
- SameSite='lax'による一次防御
- HttpOnly cookieによるXSS攻撃時の完全な保護
- ハッシュ比較によるトークン漏洩防止
- OAuthフローとの互換性
- 実装がシンプル

**デメリット:**
- Cookieが1つ追加される（最小限のオーバーヘッド）

**対応策:**
- 不要（HttpOnly Cookie PatternはXSS攻撃に対して完全に安全）

---

## Q2: SameSite属性の適切な設定

### 選択したアプローチ: オプション1

- セッションcookie: `sameSite: 'lax'`（現在通り）
- CSRFトークンcookie: `sameSite: 'lax'`に変更

### 理由

1. **OAuthコールバックの互換性**
   - 外部ドメイン（Twitch）からのリダイレクトでcookieが送信される

2. **CSRF攻撃の防止**
   - SameSite='lax'はクロスサイトPOSTリクエストでcookieが送信されない
   - CSRFトークンによる追加の検証

3. **一貫性**
   - セッションcookieとCSRFトークンcookieの設定を統一

### トレードオフ

**メリット:**
- OAuthコールバックが正常に動作
- SameSite='lax'によるCSRF防御
- 設定の一貫性

**デメリット:**
- SameSite='strict'よりもCSRF保護が弱い
- 古いブラウザでは未サポート（Safari < 12, IE）

**対応策:**
- SameSite='strict'はOAuthコールバックと互換性がないため採用しない
- 古いブラウザへの対応は、主要ブラウザの最新版を使用することを前提とする

---

## Q3: 競合状態の回避

### 選択したアプローチ: オプション1

現在のidempotent設計を維持し、コメントとドキュメントで制約を明記する。

### 理由

1. **競合状態の発生頻度が低い**
   - トークン生成は通常、セッション開始時に1回のみ
   - 並列リクエストが同時にトークン生成を呼び出す可能性は低い

2. **実装の簡潔さ**
   - 追加の複雑性を導入しない

3. **失敗時の影響が小さい**
   - 競合状態が発生しても、最後に設定されたトークンが有効
   - クライアントはトークンを再取得すれば解決

### トレードオフ

**メリット:**
- 実装がシンプル
- 追加のオーバーヘッドがない

**デメリット:**
- 競合状態が理論上は発生する可能性がある
- 並列リクエストでトークンが上書きされる可能性がある

**対応策:**
- `setCSRFToken()`関数のコメントとドキュメントで制約を明記
- テストで並列リクエストの挙動を検証

---

## Q4: エラーハンドリングの改善

### 選択したアプローチ: オプション2

エラーの種類に応じて異なるログレベルを使用する。

### 理由

1. **セキュリティとデバッグ性のバランス**
   - タイミング攻撃の疑いがある場合（WARN）：セキュリティイベントとして記録
   - バッファ長不一致（INFO）：検証失敗として記録
   - その他のエラー（ERROR）：サーバーエラーとして記録

2. **Sentryアラートの活用**
   - タイミング攻撃の疑いがある場合にSentryにアラートを送信
   - 短時間に多数の失敗がある場合に検知

### トレードオフ

**メリット:**
- セキュリティイベントと通常のエラーを区別できる
- Sentryアラートで攻撃を早期検知できる
- デバッグ性の向上

**デメリット:**
- ログ分析の複雑性が増す
- 過剰なアラートのリスク

**対応策:**
- ログ分析のダッシュボードを整備
- アラートの閾値を適切に設定

---

HttpOnly Cookie Patternでは署名は不要です。

**理由**:
- トークンはhttpOnly cookieに保存され、JavaScriptからアクセスできない
- ブラウザが自動的にトークンを送信するため、改ざんのリスクがない
- ハッシュ比較のみで十分なセキュリティが確保される

**実装の簡素化**:
- 署名関数は不要
- 環境変数 `CSRF_SIGNING_KEY` は不要
- 検証ロジックはハッシュ比較のみ

---

## 追加のセキュリティ対策

### 1. CSP（Content Security Policy）の強化

既存のCSP設定を確認し、必要に応じて強化します。

### 2. 入力検証とエスケープ

- ユーザー入力の検証を徹底
- XSS脆弱性の防止

### 3. セキュリティヘッダーの確認

- X-Content-Type-Options
- X-Frame-Options
- X-XSS-Protection

---

## まとめ

### 回答概要

| 質問 | 選択したアプローチ | 理由 |
|------|------------------|------|
| Q1: XSSとCSRFの共存 | HttpOnly Cookie Pattern + Hash Comparison | HttpOnlyによりXSS攻撃時のトークン窃取を完全防止、SameSite='lax'による一次防御、ハッシュ比較による保護 |
| Q2: SameSite設定 | オプション1: both 'lax' | OAuthコールバックの互換性、CSRF防御、設定の一貫性 |
| Q3: 競合状態 | オプション1: idempotent設計を維持 | 発生頻度が低い、実装がシンプル、失敗時の影響が小さい |
| Q4: エラーハンドリング | オプション2: ログレベルの使い分け | セキュリティイベントと通常のエラーを区別、Sentryアラートで攻撃を早期検知 |

### トレードオフのまとめ

**メインのトレードオフ:**
- **セキュリティ vs 実装の簡潔さ**
  - HttpOnly Cookie Patternは最も安全で実装がシンプル
  - OAuthフローとの完全な互換性を維持

**XSS脆弱性への対応:**
- HttpOnly CookieによりXSS攻撃時のトークン窃取を完全に防止

### 実装の優先順位

1. **HttpOnly Cookie Patternへの移行** - 即時対応
2. **不要なコンポーネントの削除**（fetchWithCSRF、/api/csrf-token） - 即時対応
3. **エラーハンドリングの改善** - 短期対応
4. **競合状態のドキュメント化** - 短期対応

---

## CI失敗の修正：TypeScript型エラー

### 2026-01-19 - TypeScript型エラーの修正

**理由**: CIが失敗しているため、型定義の不整合を修正する

**問題点**:
- `src/app/battle/stats/page.tsx:134` で TypeScript 型エラー
- `session` オブジェクトが `version` プロパティを持っていない
- `src/lib/session.ts` の `Session` インターフェースには `version` プロパティが追加されているが、クライアントコンポーネントの型定義が更新されていない

**変更内容**:
1. `src/app/battle/stats/page.tsx` の session state 型定義を更新
   - `version: number` プロパティを追加
   - 既存の型定義と `src/lib/session.ts` の `Session` インターフェースを同期

**期待される修正後のコード**:
```typescript
const [session, setSession] = useState<{
  twitchUserId: string
  twitchUsername: string
  twitchDisplayName: string
  twitchProfileImageUrl: string
  broadcasterType: string
  expiresAt: number
  version: number  // 追加
  csrfTokenHash?: string
  csrfTokenSignature?: string
} | null>(null)
```

**受け入れ基準**:
- TypeScriptビルドが成功する
- CIがパスする
- 既存の機能に影響がない

---

## 参考資料

- Issue #55: Critical Security: Missing CSRF Protection on State-Changing API Routes
- OWASP CSRF Prevention Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
- MDN Web Docs - Cross-Site Request Forgery (CSRF): https://developer.mozilla.org/en-US/docs/Web/Security/Types_of_attacks#csrf
- Next.js Security Best Practices: https://nextjs.org/docs/app/building-your-application/configuring/security
- CSRF Tokens: Simple Defense Against a Dangerous Web Attack: https://portswigger.net/web-security/csrf/tokens
- HttpOnly Cookies: https://developer.mozilla.org/en-US/docs/Web/HTTP/Cookies#restrict_access_to_cookies
- Content Security Policy (CSP): https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP