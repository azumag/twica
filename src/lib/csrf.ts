import { cookies } from 'next/headers'
import { randomBytes, timingSafeEqual, createHash } from 'crypto'

import { logger } from './logger'
import { reportSecurityError } from './sentry/error-handler'
import { COOKIE_NAMES, CSRF_CONFIG, ERROR_MESSAGES, SESSION_CONFIG } from './constants'
import { parseSession } from './session'

export function hashIp(ip: string | null): string {
  if (!ip) return 'unknown'
  return createHash('sha256').update(ip).digest('hex').substring(0, 8)
}

export function sanitizeEndpoint(url: string): string {
  try {
    const urlObj = new URL(url)
    return urlObj.pathname
  } catch {
    return 'invalid_url'
  }
}

/**
 * CSRFトークンを生成
 */
function generateCSRFToken(): string {
  return randomBytes(CSRF_CONFIG.TOKEN_LENGTH).toString('hex')
}

/**
 * トークンのハッシュを生成（SHA-256）
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * CookieからCSRFトークンを取得
 */
function getCSRFTokenFromCookie(cookieStore: Awaited<ReturnType<typeof cookies>>): string | null {
  const tokenCookie = cookieStore.get(COOKIE_NAMES.CSRF_TOKEN)?.value
  return tokenCookie || null
}

/**
 * セッションにCSRFトークンのハッシュを保存し、トークン自体はhttpOnly cookieに保存
 */
export async function setCSRFToken(retryCount: number = 0): Promise<string> {
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

  const token = generateCSRFToken()
  const tokenHash = hashToken(token)

  // 楽観的ロック: セッションを更新する前にバージョンを確認
  const currentSessionCookie = cookieStore.get(COOKIE_NAMES.SESSION)?.value
  if (!currentSessionCookie) {
    throw new Error('No session found')
  }

  const currentSession = parseSession(currentSessionCookie)
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
    return setCSRFToken(retryCount + 1)
  }

  // セッションにハッシュを保存（httpOnly）
  const updatedSession = {
    ...session,
    csrfTokenHash: tokenHash,
    version: session.version + 1,
  }

  cookieStore.set(COOKIE_NAMES.SESSION, JSON.stringify(updatedSession), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_CONFIG.MAX_AGE_SECONDS,
  })

  // トークン自体もhttpOnly cookieに保存（JavaScriptからアクセス不可）
  cookieStore.set(COOKIE_NAMES.CSRF_TOKEN, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_CONFIG.MAX_AGE_SECONDS,
  })

  logger.info(`CSRF token generated for user ${userId}`)
  return token
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
      ip: hashIp(request.headers.get('x-forwarded-for')),
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

  // Cookieからトークンを取得（HttpOnly Cookie Pattern）
  const requestToken = getCSRFTokenFromCookie(cookieStore)

  if (!requestToken) {
    logger.warn('CSRF validation failed: CSRF token missing in cookie', {
      userId: session.twitchUserId,
      endpoint: sanitizeEndpoint(request.url),
    })
    return { valid: false, error: ERROR_MESSAGES.CSRF_TOKEN_INVALID }
  }

  // トークン長の検証
  if (requestToken.length !== CSRF_CONFIG.TOKEN_LENGTH * 2) {
    logger.warn('CSRF validation failed: Invalid token length', {
      userId: session.twitchUserId,
    })
    return { valid: false, error: ERROR_MESSAGES.CSRF_TOKEN_INVALID }
  }

  // ハッシュを比較
  const requestTokenHash = hashToken(requestToken)

  const sessionBuffer = Buffer.from(sessionTokenHash)
  const requestBuffer = Buffer.from(requestTokenHash)

  // バッファ長の不一致を事前に検出
  if (sessionBuffer.length !== requestBuffer.length) {
    logger.warn('CSRF validation failed: Hash length mismatch', {
      userId: session.twitchUserId,
    })
    return { valid: false, error: ERROR_MESSAGES.CSRF_TOKEN_INVALID }
  }

  try {
    const isValid = timingSafeEqual(sessionBuffer, requestBuffer)

    if (!isValid) {
      logger.warn('CSRF token validation failed: Token mismatch (potential attack)', {
        userId: session.twitchUserId,
        ipHash: hashIp(request.headers.get('x-forwarded-for')),
        endpoint: sanitizeEndpoint(request.url),
        timestamp: new Date().toISOString(),
      })

      reportSecurityError(new Error('CSRF token mismatch'), {
        action: 'csrf_validation',
        userId: session.twitchUserId,
      })

      return { valid: false, error: ERROR_MESSAGES.CSRF_TOKEN_INVALID }
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
    return
  }

  const session = parseSession(sessionCookie)

  // セッションからハッシュを削除し、バージョン番号をインクリメント
  if (session.csrfTokenHash) {
    const sessionWithoutCsrf = { ...session, version: session.version + 1 }
    delete sessionWithoutCsrf.csrfTokenHash

    cookieStore.set(COOKIE_NAMES.SESSION, JSON.stringify(sessionWithoutCsrf), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_CONFIG.MAX_AGE_SECONDS,
    })
  }

  // CSRFトークンクッキーを削除
  cookieStore.delete(COOKIE_NAMES.CSRF_TOKEN)

  logger.info('CSRF token cleared')
}