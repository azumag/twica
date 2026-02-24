# Task: 楽観的ロックの実装 (優先度3)

## 目標
セッションにバージョン番号を追加し、トークン生成時に競合状態を回避する

## 設計書参照
docs/ARCHITECTURE.md - 「質問3: トークン生成の競合状態」セクション（0957-01063行目）

## 変更内容

### 1. src/lib/session.ts

#### Sessionインターフェースの変更
```typescript
export interface Session {
  twitchUserId: string
  twitchUsername: string
  csrfTokenHash?: string
  version: number  // 追加: 楽観的ロック用
}
```

#### createSession関数の変更
```typescript
export function createSession(userId: string, username: string): string {
  const session: Session = {
    twitchUserId: userId,
    twitchUsername: username,
    version: 1,  // 追加
  }
  return JSON.stringify(session)
}
```

### 2. src/lib/csrf.ts

#### setCSRFToken関数の変更
```typescript
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

## 理由
- 現在のidempotent設計では、セッションの読み取りと更新の間に別のリクエストが介入した場合、トークンが上書きされる可能性がある
- 排他制御はパフォーマンスへの影響が大きいため、楽観的ロックを採用する
- セッションにバージョン番号を追加し、更新時に検証することで、競合状態を回避する

## 期待される結果
- 競合状態が確実に回避できる
- 排他制御と比較してパフォーマンスへの影響が少ない

## 検証方法
1. 同時リクエストを送信し、トークンが正しく生成されることを確認
2. バージョン番号が正しくインクリメントされることを確認
3. バージョン不一致時のリトライが正常に動作することを確認
