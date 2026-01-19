# レビュー回答: CSRF保護の設計修正 (2026-01-19)

## 質問1: XSS脆弱性とCSRF保護の共存

**選択したアプローチ: アプローチA - HttpOnly Cookieパターン**

**理由**:
- XSS脆弱性がある場合、JavaScript経由でトークンを操作すること自体が問題であるため、トークンをJavaScriptからアクセス不可能にする
- SameSite='lax'はOAuthコールバックを許可し、かつGETリクエスト以外のクロスサイトリクエストをブロックする
- CSRFトークンをhttpOnly cookieに保存し、SameSite='lax'を設定することで、外部サイトからのPOSTリクエストはブロックされる
- X-CSRF-Tokenヘッダーは不要（cookieが自動的に送信されるため）

**変更内容**:

1. **CSRFトークンをhttpOnly cookieに保存**:
   ```typescript
   // src/lib/csrf.ts
   cookieStore.set('csrf_token', token, {
     httpOnly: true,  // 変更: JavaScriptからアクセス不可
     secure: process.env.NODE_ENV === 'production',
     sameSite: 'lax',  // 変更: OAuthコールバックを許可
     path: '/',
     maxAge: SESSION_CONFIG.MAX_AGE_SECONDS,
   })
   ```

2. **X-CSRF-Tokenヘッダーの削除**:
   - クライアント側で`X-CSRF-Token`ヘッダーを送信する必要がなくなる
   - サーバー側でヘッダーを検証する必要がなくなる

3. **CSRF検証ロジックの簡略化**:
   ```typescript
   // src/lib/csrf.ts
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

4. **クライアント側の変更**:
   ```typescript
   // src/lib/client/csrf.ts
   // 変更: Cookieからトークンを取得する必要がない
   // fetchWithCSRFは単純なfetchラッパーに変更

   export async function fetchWithCSRF(
     url: string,
     options: RequestInit = {}
   ): Promise<Response> {
     // CSRFトークンはhttpOnly cookieに保存され、自動的に送信される
     return fetch(url, options)
   }
   ```

**トレードオフ**:
- メリット: XSS脆弱性がある場合でも、CSRFトークンが窃取されない
- メリット: クライアント側の実装が簡素化される
- デメリット: X-CSRF-Tokenヘッダーによる追加の検証レイヤーがなくなる（SameSite='lax'で代用）

---

## 質問2: SameSite属性の適切な設定

**選択したオプション: オプション1**

**内容**:
- セッションcookie: `sameSite: 'lax'`（変更なし）
- CSRFトークンcookie: `sameSite: 'lax'`に変更

**理由**:
- OAuthコールバックは外部ドメイン（Twitch）からのリダイレクトであるため、`sameSite: 'lax'`が必要
- `sameSite: 'lax'`はトップレベルナビゲーション（GETリクエスト）でcookieを許可し、クロスサイトPOSTリクエストでcookieをブロックする
- これにより、OAuthコールバックは正常に動作し、CSRF攻撃（POSTリクエスト）は防止される

**変更内容**:

```typescript
// src/lib/csrf.ts
cookieStore.set('csrf_token', token, {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',  // 変更: 'strict'から'lax'に変更
  path: '/',
  maxAge: SESSION_CONFIG.MAX_AGE_SECONDS,
})
```

**トレードオフ**:
- メリット: OAuthコールバックが正常に動作する
- メリット: CSRF攻撃（POSTリクエスト）は防止される
- デメリット: `sameSite: 'strict'`よりは弱い（ただしCSRF保護としては十分）

---

## 質問3: トークン生成の競合状態

**選択したオプション: オプション2 - 楽観的ロック（Optimistic Locking）**

**理由**:
- 現在のidempotent設計では、セッションの読み取りと更新の間に別のリクエストが介入した場合、トークンが上書きされる可能性がある
- 排他制御（Pessimistic Locking）はパフォーマンスへの影響が大きいため、楽観的ロックを採用する
- セッションにバージョン番号を追加し、更新時に検証することで、競合状態を回避する

**変更内容**:

1. **セッションにバージョン番号を追加**:
   ```typescript
   // src/lib/session.ts
   export interface Session {
     twitchUserId: string
     twitchUsername: string
     csrfTokenHash?: string
     version: number  // 追加: 楽観的ロック用
   }

   export function createSession(userId: string, username: string): string {
     const session: Session = {
       twitchUserId: userId,
       twitchUsername: username,
       version: 1,  // 追加
     }
     return JSON.stringify(session)
   }
   ```

2. **setCSRFToken関数を修正**:
   ```typescript
   // src/lib/csrf.ts
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
       const existingToken = getCSRFTokenFromCookie(cookieStore)
       if (existingToken) {
         return existingToken
       }
     }

     // 新しいトークンを生成
     const token = generateCSRFToken()
     const tokenHash = hashToken(token)

     // 楽観的ロック: セッションを更新する前にバージョンを確認
     const currentSessionCookie = cookieStore.get(COOKIE_NAMES.SESSION)?.value
     if (!currentSessionCookie) {
       throw new Error('No session found')
     }

     const currentSession = parseSession(currentSessionCookie)
     if (currentSession.version !== session.version) {
       // バージョンが不一致の場合、リトライ
       logger.warn('CSRF token generation: Version mismatch, retrying', {
         userId,
         expectedVersion: session.version,
         actualVersion: currentSession.version,
       })
       return setCSRFToken()  // 再帰的にリトライ
     }

     // セッションにハッシュを保存（httpOnly）
     const updatedSession = {
       ...session,
       csrfTokenHash: tokenHash,
       version: session.version + 1,  // バージョンをインクリメント
     }

     cookieStore.set(COOKIE_NAMES.SESSION, JSON.stringify(updatedSession), {
       httpOnly: true,
       secure: process.env.NODE_ENV === 'production',
       sameSite: 'lax',
       path: '/',
       maxAge: SESSION_CONFIG.MAX_AGE_SECONDS,
     })

     // トークン自体はhttpOnly cookieに保存
     cookieStore.set('csrf_token', token, {
       httpOnly: true,
       secure: process.env.NODE_ENV === 'production',
       sameSite: 'lax',
       path: '/',
       maxAge: SESSION_CONFIG.MAX_AGE_SECONDS,
     })

     logger.info(`CSRF token generated for user ${userId}`)
     return token
   }
   ```

**トレードオフ**:
- メリット: 競合状態を確実に回避できる
- メリット: 排他制御と比較してパフォーマンスへの影響が少ない
- デメリット: 再帰的なリトライが発生する可能性がある（ただし、現実的なシナリオでは稀）

---

## 質問4: エラーハンドリングの改善

**選択したオプション: オプション2**

**内容**:
- エラーの種類に応じて異なるログレベルを使用
- バッファ長不一致はINFO、タイミング攻撃の疑いはWARN、その他はERROR

**理由**:
- 現在の設計では、すべてのエラーがWARNとして記録されている
- エラーの種類に応じてログレベルを分けることで、より適切な監視が可能になる
- タイミング攻撃の疑いがある場合は、アラートとして検知しやすくなる

**変更内容**:

```typescript
// src/lib/csrf.ts
export async function validateCSRFToken(
  request: Request
): Promise<{ valid: boolean; error?: string }> {
  const cookieStore = await cookies()
  const sessionCookie = cookieStore.get(COOKIE_NAMES.SESSION)?.value

  if (!sessionCookie) {
    logger.info('CSRF validation failed: No session found', {  // INFOレベル
      ip: request.headers.get('x-forwarded-for'),
      userAgent: request.headers.get('user-agent'),
    })
    return { valid: false, error: ERROR_MESSAGES.CSRF_TOKEN_INVALID }
  }

  const session = parseSession(sessionCookie)
  const sessionTokenHash = session.csrfTokenHash

  if (!sessionTokenHash) {
    logger.info('CSRF validation failed: No CSRF token in session', {  // INFOレベル
      userId: session.twitchUserId,
    })
    return { valid: false, error: ERROR_MESSAGES.CSRF_TOKEN_INVALID }
  }

  const requestToken = cookieStore.get('csrf_token')?.value

  if (!requestToken) {
    logger.info('CSRF validation failed: CSRF token missing in request', {  // INFOレベル
      userId: session.twitchUserId,
      endpoint: request.url,
    })
    return { valid: false, error: ERROR_MESSAGES.CSRF_TOKEN_INVALID }
  }

  const requestTokenHash = hashToken(requestToken)

  try {
    const isValid = crypto.timingSafeEqual(
      Buffer.from(sessionTokenHash),
      Buffer.from(requestTokenHash)
    )

    if (!isValid) {
      logger.warn('CSRF token validation failed: Token mismatch (potential attack)', {  // WARNレベル
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
    logger.error('CSRF validation failed: Hash comparison error', {  // ERRORレベル
      userId: session.twitchUserId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    })
    return { valid: false, error: ERROR_MESSAGES.CSRF_TOKEN_INVALID }
  }
}
```

**トレードオフ**:
- メリット: エラーの種類に応じて適切な監視が可能
- メリット: タイミング攻撃の疑いがある場合、早期に検知できる
- デメリット: ログの量が増える可能性がある（ただし、INFOレベルはフィルタリング可能）
