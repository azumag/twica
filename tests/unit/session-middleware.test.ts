import { describe, it, expect, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { updateSession } from '@/lib/session-middleware'
import { COOKIE_NAMES } from '@/lib/constants'
import { signSession } from '@/lib/session-cookie'

/**
 * Tests for middleware session cleanup logic.
 *
 * Key behavior:
 * - Expired session cookies are NOT deleted (preserved for scope restoration during re-login)
 * - CSRF cookies ARE deleted when session expires (no longer needed)
 * - Unparseable (corrupted/tampered) session cookies are deleted (security)
 *
 * ミドルウェアでのセッションクリーンアップロジックのテスト。
 *
 * 主な動作:
 * - 期限切れセッションCookieは削除しない（再ログイン時のスコープ保持に必要）
 * - CSRFトークンはセッション期限切れ時に削除する（不要のため）
 * - パースできないCookieは削除する（セキュリティ対策）
 */
describe('updateSession middleware', () => {
  const originalSecret = process.env.SESSION_COOKIE_SECRET
  const validSession = {
    twitchUserId: '12345',
    twitchUsername: 'testuser',
    twitchDisplayName: 'Test User',
    twitchProfileImageUrl: 'https://example.com/image.png',
    broadcasterType: 'affiliate',
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    version: 1,
  }

  beforeEach(() => {
    if (originalSecret === undefined) {
      delete process.env.SESSION_COOKIE_SECRET
    } else {
      process.env.SESSION_COOKIE_SECRET = originalSecret
    }
  })

  function createRequest(cookies?: Record<string, string>): NextRequest {
    const url = 'https://example.com/'
    const request = new NextRequest(url)
    if (cookies) {
      for (const [name, value] of Object.entries(cookies)) {
        request.cookies.set(name, value)
      }
    }
    return request
  }

  it('should pass through request when no session cookie exists', async () => {
    const request = createRequest()
    const response = await updateSession(request)

    // No Set-Cookie headers should be added
    const setCookieHeader = response.headers.get('set-cookie')
    expect(setCookieHeader).toBeNull()
  })

  it('should pass through request when session is valid (not expired)', async () => {
    const request = createRequest({
      [COOKIE_NAMES.SESSION]: JSON.stringify(validSession),
    })
    const response = await updateSession(request)

    // No Set-Cookie headers should be added for valid sessions
    const setCookieHeader = response.headers.get('set-cookie')
    expect(setCookieHeader).toBeNull()
  })

  it('should clear CSRF cookie when session is expired and csrf_token exists in request', async () => {
    // 期限切れセッション + csrf_tokenあり → csrf_tokenのみ削除
    const expiredSession = {
      ...validSession,
      expiresAt: Date.now() - 1000, // expired 1 second ago
    }
    const request = createRequest({
      [COOKIE_NAMES.SESSION]: JSON.stringify(expiredSession),
      [COOKIE_NAMES.CSRF_TOKEN]: 'existing-csrf-token',
    })
    const response = await updateSession(request)

    // セッションCookieは保持（スコープ保持のため）
    const sessionCookie = response.cookies.get(COOKIE_NAMES.SESSION)
    expect(sessionCookie).toBeUndefined()

    // CSRFトークンは削除される（期限切れセッションでは不要）
    const csrfCookie = response.cookies.get(COOKIE_NAMES.CSRF_TOKEN)
    expect(csrfCookie?.value).toBe('')
  })

  it('should not emit Set-Cookie when session is expired but csrf_token is absent', async () => {
    // 期限切れセッション + csrf_tokenなし → Set-Cookieヘッダを出さない（キャッシュ効率維持）
    const expiredSession = {
      ...validSession,
      expiresAt: Date.now() - 1000,
    }
    const request = createRequest({
      [COOKIE_NAMES.SESSION]: JSON.stringify(expiredSession),
    })
    const response = await updateSession(request)

    // Set-Cookieヘッダが一切出ないことを確認
    const setCookieHeader = response.headers.get('set-cookie')
    expect(setCookieHeader).toBeNull()
  })

  it('should clear both session and CSRF cookies when cookie value is not valid JSON', async () => {
    const request = createRequest({
      [COOKIE_NAMES.SESSION]: 'invalid-json-value',
      [COOKIE_NAMES.CSRF_TOKEN]: 'some-csrf-token',
    })
    const response = await updateSession(request)

    // Verify both cookies are cleared for unparseable values
    const sessionCookie = response.cookies.get(COOKIE_NAMES.SESSION)
    expect(sessionCookie?.value).toBe('')
    const csrfCookie = response.cookies.get(COOKIE_NAMES.CSRF_TOKEN)
    expect(csrfCookie?.value).toBe('')
  })

  it('should clear cookies when expiresAt is missing (invalid structure)', async () => {
    const sessionWithoutExpiry = {
      ...validSession,
      expiresAt: undefined,
    }
    const request = createRequest({
      [COOKIE_NAMES.SESSION]: JSON.stringify(sessionWithoutExpiry),
    })
    const response = await updateSession(request)

    const sessionCookie = response.cookies.get(COOKIE_NAMES.SESSION)
    expect(sessionCookie?.value).toBe('')
  })

  it('should preserve session cookie even when expired for a long time', async () => {
    // 長期間経過した期限切れセッションもスコープ保持のために残す
    const longExpiredSession = {
      ...validSession,
      expiresAt: Date.now() - 20 * 24 * 60 * 60 * 1000, // expired 20 days ago
    }
    const request = createRequest({
      [COOKIE_NAMES.SESSION]: JSON.stringify(longExpiredSession),
      [COOKIE_NAMES.CSRF_TOKEN]: 'old-csrf-token',
    })
    const response = await updateSession(request)

    // セッションCookieは保持
    const sessionCookie = response.cookies.get(COOKIE_NAMES.SESSION)
    expect(sessionCookie).toBeUndefined()

    // CSRFトークンのみ削除される
    const csrfCookie = response.cookies.get(COOKIE_NAMES.CSRF_TOKEN)
    expect(csrfCookie?.value).toBe('')
  })

  it('should not emit Set-Cookie for unparseable session when csrf_token is absent', async () => {
    // パース不可 + csrf_tokenなし → セッションCookieのみ削除、csrf_tokenのSet-Cookieは出さない
    const request = createRequest({
      [COOKIE_NAMES.SESSION]: 'invalid-json-value',
    })
    const response = await updateSession(request)

    // セッションCookieは削除される
    const sessionCookie = response.cookies.get(COOKIE_NAMES.SESSION)
    expect(sessionCookie?.value).toBe('')

    // csrf_tokenのSet-Cookieは出ない
    const csrfCookie = response.cookies.get(COOKIE_NAMES.CSRF_TOKEN)
    expect(csrfCookie).toBeUndefined()
  })

  it('should pass through request when session is valid and signed', async () => {
    process.env.SESSION_COOKIE_SECRET = 'test-secret-key-32-chars-abcdefgh'
    const signedSession = await signSession(JSON.stringify(validSession))

    const request = createRequest({
      [COOKIE_NAMES.SESSION]: signedSession,
    })
    const response = await updateSession(request)

    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('should preserve legacy unsigned cookies when signature enforcement is enabled', async () => {
    process.env.SESSION_COOKIE_SECRET = 'test-secret-key-32-chars-abcdefgh'

    const request = createRequest({
      [COOKIE_NAMES.SESSION]: JSON.stringify(validSession),
    })
    const response = await updateSession(request)

    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('should clear signed-looking cookies when SESSION_COOKIE_SECRET is not set', async () => {
    delete process.env.SESSION_COOKIE_SECRET

    const request = createRequest({
      [COOKIE_NAMES.SESSION]: `${JSON.stringify(validSession)}.${'a'.repeat(64)}`,
      [COOKIE_NAMES.CSRF_TOKEN]: 'some-csrf-token',
    })
    const response = await updateSession(request)

    expect(response.cookies.get(COOKIE_NAMES.SESSION)?.value).toBe('')
    expect(response.cookies.get(COOKIE_NAMES.CSRF_TOKEN)?.value).toBe('')
  })

  it('should clear signed cookies when signature verification fails', async () => {
    process.env.SESSION_COOKIE_SECRET = 'test-secret-key-32-chars-abcdefgh'
    const signedSession = await signSession(JSON.stringify(validSession))
    const tamperedSession = signedSession.replace(/.$/, signedSession.endsWith('a') ? 'b' : 'a')

    const request = createRequest({
      [COOKIE_NAMES.SESSION]: tamperedSession,
      [COOKIE_NAMES.CSRF_TOKEN]: 'some-csrf-token',
    })
    const response = await updateSession(request)

    expect(response.cookies.get(COOKIE_NAMES.SESSION)?.value).toBe('')
    expect(response.cookies.get(COOKIE_NAMES.CSRF_TOKEN)?.value).toBe('')
  })
})
