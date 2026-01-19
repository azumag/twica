# Task: HttpOnly Cookieパターンへの移行 (優先度2)

## 目標
CSRFトークンをhttpOnly cookieに保存し、X-CSRF-Tokenヘッダーを削除する

## 設計書参照
docs/ARCHITECTURE.md - 「質問1: XSS脆弱性とCSRF保護の共存」セクション（0811-0921行目）

## 変更内容

### 1. src/lib/csrf.ts

#### setCSRFToken関数の変更
```typescript
// CSRFトークンをhttpOnly cookieに保存
cookieStore.set('csrf_token', token, {
  httpOnly: true,  // trueに変更（JavaScriptからアクセス不可）
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
  maxAge: SESSION_CONFIG.MAX_AGE_SECONDS,
})
```

#### validateCSRFToken関数の変更
```typescript
export async function validateCSRFToken(
  request: Request
): Promise<{ valid: boolean; error?: string }> {
  const cookieStore = await cookies()
  const sessionCookie = cookieStore.get(COOKIE_NAMES.SESSION)?.value

  if (!sessionCookie) {
    return { valid: false, error: ERROR_MESSAGES.CSRF_TOKEN_INVALID }
  }

  const session = parseSession(sessionCookie)
  const sessionTokenHash = session.csrfTokenHash

  if (!sessionTokenHash) {
    return { valid: false, error: ERROR_MESSAGES.CSRF_TOKEN_INVALID }
  }

  // cookieからCSRFトークンを取得（httpOnly cookieは自動的に送信される）
  const requestToken = cookieStore.get('csrf_token')?.value

  if (!requestToken) {
    return { valid: false, error: ERROR_MESSAGES.CSRF_TOKEN_INVALID }
  }

  // ハッシュを比較
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
    logger.warn('CSRF validation failed: Hash comparison error', {
      userId: session.twitchUserId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { valid: false, error: ERROR_MESSAGES.CSRF_TOKEN_INVALID }
  }
}
```

### 2. src/lib/client/csrf.ts

#### fetchWithCSRF関数の変更
```typescript
export async function fetchWithCSRF(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  // CSRFトークンはhttpOnly cookieに保存され、自動的に送信される
  // X-CSRF-Tokenヘッダーは不要
  return fetch(url, options)
}
```

## 理由
- XSS脆弱性がある場合、JavaScript経由でトークンを操作すること自体が問題であるため、トークンをJavaScriptからアクセス不可能にする
- SameSite='lax'はOAuthコールバックを許可し、かつGETリクエスト以外のクロスサイトリクエストをブロックする
- CSRFトークンをhttpOnly cookieに保存し、SameSite='lax'を設定することで、外部サイトからのPOSTリクエストはブロックされる

## 期待される結果
- XSS脆弱性がある場合でも、CSRFトークンが窃取されない
- クライアント側の実装が簡素化される

## 検証方法
1. CSRFトークンがhttpOnly cookieに保存されていることを確認
2. X-CSRF-Tokenヘッダーを削除してもリクエストが成功することを確認
3. すべてのPOST/PUT/DELETE APIルートが正常に動作することを確認
