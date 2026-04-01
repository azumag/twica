import { cookies } from 'next/headers'

import { logger } from './logger'
import { reportSecurityError } from './sentry/error-handler'
import { COOKIE_NAMES, CSRF_CONFIG, ERROR_MESSAGES, getSessionCookieOptions, getDeleteCookieOptions } from './constants'
import { parseSession, signSession, type Session, verifySession } from './session'

export async function hashIP(ip: string | null): Promise<string> {
  if (!ip) return 'unknown'
  const encoder = new TextEncoder()
  const data = encoder.encode(ip)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
  return hashHex.substring(0, 8)
}

export function sanitizeURL(url: string): string {
  try {
    const urlObj = new URL(url)
    return urlObj.pathname
  } catch {
    return 'invalid_url'
  }
}

/**
 * CSRFトークンを生成 (Web Crypto API)
 */
function generateCSRFToken(): string {
  const bytes = new Uint8Array(CSRF_CONFIG.TOKEN_LENGTH)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * トークンのハッシュを生成（SHA-256、Web Crypto API）
 */
export async function hashToken(token: string): Promise<string> {
  const salt = process.env.CSRF_TOKEN_SALT

  if (!salt) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('CSRF_TOKEN_SALT environment variable is required in production')
    }

    logger.warn('CSRF_TOKEN_SALT is not set, using default salt. Please set CSRF_TOKEN_SALT in your .env file')
    const encoder = new TextEncoder()
    const data = encoder.encode(token + 'default-salt')
    const hashBuffer = await crypto.subtle.digest('SHA-256', data)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
  }

  const encoder = new TextEncoder()
  const data = encoder.encode(token + salt)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * CookieからCSRFトークンを取得
 */
function getCSRFTokenFromCookie(cookieStore: Awaited<ReturnType<typeof cookies>>): string | null {
  const tokenCookie = cookieStore.get(COOKIE_NAMES.CSRF_TOKEN)?.value
  return tokenCookie || null
}

async function readSessionFromCookieValue(sessionCookie: string): Promise<Session> {
  const payload = await verifySession(sessionCookie)
  return parseSession(payload)
}

async function serializeSessionCookie(session: Session): Promise<string> {
  return signSession(JSON.stringify(session))
}

/**
 * セッションにCSRFトークンのハッシュを保存し、トークン自体はhttpOnly cookieに保存
 */
async function setCSRFTokenWithRetry(retryCount: number = 0): Promise<string> {
  const cookieStore = await cookies()

  const sessionCookie = cookieStore.get(COOKIE_NAMES.SESSION)?.value
  if (!sessionCookie) {
    throw new Error('No session found')
  }

  const session = await readSessionFromCookieValue(sessionCookie)
  const userId = session.twitchUserId

  const existingToken = getCSRFTokenFromCookie(cookieStore)
  if (session.csrfTokenHash && existingToken) {
    return existingToken
  }

  const token = generateCSRFToken()
  const tokenHash = await hashToken(token)

  // 楽観的ロック: セッションを更新する前にバージョンを確認
  const currentSessionCookie = cookieStore.get(COOKIE_NAMES.SESSION)?.value
  if (!currentSessionCookie) {
    throw new Error('No session found')
  }

  const currentSession = await readSessionFromCookieValue(currentSessionCookie)
  
  // Check session expiration before version validation
  if (currentSession.expiresAt && Date.now() > currentSession.expiresAt) {
    throw new Error('Session expired')
  }
  
  if (currentSession.version !== session.version) {
    if (retryCount >= CSRF_CONFIG.MAX_RETRY_COUNT) {
      logger.error('CSRF token generation: Max retry count exceeded', {
        userId,
        retryCount,
        expectedVersion: session.version,
        actualVersion: currentSession.version,
      })
      throw new Error('CSRF token generation failed: Concurrent modification detected')
    }

    logger.warn('CSRF token generation: Version mismatch, retrying', {
      userId,
      retryCount,
      expectedVersion: session.version,
      actualVersion: currentSession.version,
    })

    await new Promise(resolve => setTimeout(resolve, CSRF_CONFIG.RETRY_DELAY_MS))
    return setCSRFTokenWithRetry(retryCount + 1)
  }

  const updatedSession = { ...session, csrfTokenHash: tokenHash, version: session.version + 1 }

  // セッションとCSRFトークンは同じドメイン設定で保存
  const cookieOptions = getSessionCookieOptions()
  const updatedSessionCookie = await serializeSessionCookie(updatedSession)
  cookieStore.set(COOKIE_NAMES.SESSION, updatedSessionCookie, cookieOptions)

  // トークン自体もhttpOnly cookieに保存（JavaScriptからアクセス不可）
  cookieStore.set(COOKIE_NAMES.CSRF_TOKEN, token, cookieOptions)

  logger.info(`CSRF token generated for user ${userId}`)
  return token
}

export async function setCSRFToken(): Promise<string> {
  return setCSRFTokenWithRetry(0)
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
      ip: await hashIP(request.headers.get('x-forwarded-for')),
      userAgent: request.headers.get('user-agent'),
    })
    return { valid: false, error: 'セッションが見つかりません。再度ログインしてください。' }
  }

  let session: Session
  try {
    session = await readSessionFromCookieValue(sessionCookie)
  } catch {
    logger.warn('CSRF validation failed: Invalid session cookie')
    return { valid: false, error: 'セッションが見つかりません。再度ログインしてください。' }
  }

  if (session.expiresAt && Date.now() > session.expiresAt) {
    logger.warn('CSRF validation failed: Session expired', {
      userId: session.twitchUserId,
    })
    return { valid: false, error: 'セッションの有効期限が切れました。再度ログインしてください。' }
  }

  let sessionTokenHash = session.csrfTokenHash
  let generatedToken: string | null = null

  // If no CSRF token in session, generate one lazily (for first POST after OAuth)
  if (!sessionTokenHash) {
    try {
      logger.info('Generating CSRF token lazily for first POST request', {
        userId: session.twitchUserId,
      })
      generatedToken = await setCSRFToken()
      // Re-read session after generating token
      const updatedSessionCookie = cookieStore.get(COOKIE_NAMES.SESSION)?.value
      if (!updatedSessionCookie) {
        logger.error('Failed to read session after CSRF token generation')
        return { valid: false, error: ERROR_MESSAGES.CSRF_TOKEN_INVALID }
      }
      const updatedSession = await readSessionFromCookieValue(updatedSessionCookie)
      sessionTokenHash = updatedSession.csrfTokenHash

      if (!sessionTokenHash) {
        logger.error('CSRF token hash missing after generation')
        return { valid: false, error: ERROR_MESSAGES.CSRF_TOKEN_INVALID }
      }
    } catch (error) {
      logger.error('Failed to generate CSRF token', { error, userId: session.twitchUserId })
      return { valid: false, error: ERROR_MESSAGES.CSRF_TOKEN_INVALID }
    }
  }

  // Cookieからトークンを取得（HttpOnly Cookie Pattern）
  // 遅延生成した場合は、同じリクエスト内ではCookieから読み取れないため、生成したトークンを使用
  const requestToken = generatedToken || getCSRFTokenFromCookie(cookieStore)

  if (!requestToken || typeof requestToken !== 'string' || requestToken.trim() === '') {
    logger.warn('CSRF validation failed: CSRF token missing or invalid in cookie', {
      userId: session.twitchUserId,
      endpoint: sanitizeURL(request.url),
      hasSessionTokenHash: !!sessionTokenHash,
    })
    return { valid: false, error: 'CSRFトークンがCookieに見つかりません。ページを再読み込みしてください。' }
  }

  // Originヘッダーの検証（多層防御として）
  const origin = request.headers.get('origin')
  const referer = request.headers.get('referer')
  const requestUrl = new URL(request.url)
  const expectedOrigin = `${requestUrl.protocol}//${requestUrl.host}`

  function isLocalOrigin(origin: string): boolean {
    try {
      const url = new URL(origin)
      const hostname = url.hostname
      
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
        return true
      }
      
      const localNetworkPatterns = [
        /^192\.168\.\d+\.\d+$/,
        /^10\.\d+\.\d+\.\d+$/,
        /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
      ]
      
      return localNetworkPatterns.some(pattern => pattern.test(hostname))
    } catch {
      return false
    }
  }

  // リクエストURL自体のoriginと一致する場合は同一オリジンリクエストなので許可する
  // （例: workers.dev URLからのリクエストでNEXT_PUBLIC_APP_URLがカスタムドメインの場合）
  if (origin && origin !== expectedOrigin && !CSRF_CONFIG.ALLOWED_ORIGINS.includes(origin)) {
    const isLocal = CSRF_CONFIG.ALLOW_LOCAL_ORIGINS && isLocalOrigin(origin)

    if (!isLocal) {
      logger.warn('CSRF validation failed: Origin header not in allowed list', {
        userId: session.twitchUserId,
        origin,
        allowedOrigins: CSRF_CONFIG.ALLOWED_ORIGINS,
        allowLocalOrigins: CSRF_CONFIG.ALLOW_LOCAL_ORIGINS,
        endpoint: sanitizeURL(request.url),
      })
      return { valid: false, error: `Originヘッダーが許可リストにありません: ${origin}` }
    }
  }

  // Originヘッダーがない場合、Refererヘッダーを検証（オプション）
  if (!origin && referer) {
    try {
      const refererUrl = new URL(referer)
      const refererOrigin = `${refererUrl.protocol}//${refererUrl.host}`
      if (refererOrigin !== expectedOrigin) {
        logger.warn('CSRF validation failed: Referer header mismatch', {
          userId: session.twitchUserId,
          referer: refererOrigin,
          expectedOrigin,
          endpoint: sanitizeURL(request.url),
        })
        return { valid: false, error: ERROR_MESSAGES.CSRF_TOKEN_INVALID }
      }
    } catch (error) {
      logger.info('Failed to parse referer header', {
        referer,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }

  // Tokens are hex-encoded (2 chars per byte)
  // トークン長の検証
  if (requestToken.length !== CSRF_CONFIG.TOKEN_LENGTH * 2) {
    logger.warn('CSRF validation failed: Invalid token length', {
      userId: session.twitchUserId,
      expectedLength: CSRF_CONFIG.TOKEN_LENGTH * 2,
      actualLength: requestToken.length,
    })
    return { valid: false, error: 'CSRFトークンの長さが不正です。ページを再読み込みしてください。' }
  }

  // ハッシュを比較
  const requestTokenHash = await hashToken(requestToken)

  // バッファ長の不一致を事前に検出
  if (sessionTokenHash.length !== requestTokenHash.length) {
    logger.warn('CSRF validation failed: Hash length mismatch', {
      userId: session.twitchUserId,
    })
    return { valid: false, error: 'CSRFトークンのハッシュ長が一致しません。' }
  }

  try {
    // Web Crypto APIを使用したタイミングセーフな比較
    const encoder = new TextEncoder()
    const sessionBuffer = encoder.encode(sessionTokenHash)
    const requestBuffer = encoder.encode(requestTokenHash)

    // constant-time comparison using crypto.subtle.timingSafeEqual (Edge Runtime compatible)
    let isValid = sessionBuffer.length === requestBuffer.length
    if (isValid) {
      for (let i = 0; i < sessionBuffer.length; i++) {
        if (sessionBuffer[i] !== requestBuffer[i]) {
          isValid = false
          // Don't break early to maintain constant time
        }
      }
    }

    if (!isValid) {
      logger.warn('CSRF token validation failed: Token mismatch (potential attack)', {
        userId: session.twitchUserId,
        ipHash: await hashIP(request.headers.get('x-forwarded-for')),
        endpoint: sanitizeURL(request.url),
        timestamp: new Date().toISOString(),
      })

      // await: Cloudflare Workers ではレスポンス完了後に未完了の非同期タスクがキャンセルされるため
      // Supabase へのエラーログ記録を確実に完了させる
      await reportSecurityError(new Error('CSRF token mismatch'), {
        action: 'csrf_validation',
        userId: session.twitchUserId,
      })

      return { valid: false, error: 'CSRFトークンが一致しません。ページを再読み込みして再度お試しください。' }
    }

    return { valid: true }
  } catch (error) {
    if (error instanceof Error && error.name === 'RangeError') {
      logger.warn('CSRF validation failed: Buffer length mismatch', {
        userId: session.twitchUserId,
      })
    } else {
      logger.error('CSRF validation failed: Unexpected error', {
        userId: session.twitchUserId,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }

    return { valid: false, error: ERROR_MESSAGES.CSRF_TOKEN_INVALID }
  }
}

/**
 * セッションからCSRFトークンを削除
 */
export async function clearCSRFToken(): Promise<void> {
  const cookieStore = await cookies()
  const sessionCookie = cookieStore.get(COOKIE_NAMES.SESSION)?.value

  if (!sessionCookie) {
    // セッションがなくてもCSRFトークンCookieは削除を試みる
    cookieStore.set(COOKIE_NAMES.CSRF_TOKEN, '', getDeleteCookieOptions())
    return
  }

  let session: Session
  try {
    session = await readSessionFromCookieValue(sessionCookie)
  } catch {
    cookieStore.set(COOKIE_NAMES.CSRF_TOKEN, '', getDeleteCookieOptions())
    return
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { csrfTokenHash, ...sessionWithoutCsrf } = session
  const updatedSession = {
    ...sessionWithoutCsrf,
    version: session.version + 1,
  }

  // ドメイン設定を含むオプションで保存
  const updatedSessionCookie = await serializeSessionCookie(updatedSession)
  cookieStore.set(COOKIE_NAMES.SESSION, updatedSessionCookie, getSessionCookieOptions())

  // CSRFトークンクッキーを確実に削除（maxAge=0で上書き）
  cookieStore.set(COOKIE_NAMES.CSRF_TOKEN, '', getDeleteCookieOptions())

  logger.info('CSRF token cleared')
}
