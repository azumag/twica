import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'
import { COOKIE_NAMES } from '@/lib/constants'

/**
 * Tests for middleware session cleanup logic.
 * Expired or malformed session cookies should be cleared in middleware,
 * because Server Components cannot modify cookies (Next.js restriction).
 *
 * ミドルウェアでのセッションクリーンアップロジックのテスト。
 * 期限切れまたは不正なセッションCookieはミドルウェアでクリアする必要がある。
 * Server ComponentではCookieの変更がNext.jsにより禁止されているため。
 */
describe('updateSession middleware', () => {
  const validSession = {
    twitchUserId: '12345',
    twitchUsername: 'testuser',
    twitchDisplayName: 'Test User',
    twitchProfileImageUrl: 'https://example.com/image.png',
    broadcasterType: 'affiliate',
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    version: 1,
  }

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

  it('should clear session and CSRF cookies when session is expired', async () => {
    const expiredSession = {
      ...validSession,
      expiresAt: Date.now() - 1000, // expired 1 second ago
    }
    const request = createRequest({
      [COOKIE_NAMES.SESSION]: JSON.stringify(expiredSession),
    })
    const response = await updateSession(request)

    // Verify session cookie is cleared (maxAge=0)
    const sessionCookie = response.cookies.get(COOKIE_NAMES.SESSION)
    expect(sessionCookie?.value).toBe('')

    // Verify CSRF cookie is also cleared
    const csrfCookie = response.cookies.get(COOKIE_NAMES.CSRF_TOKEN)
    expect(csrfCookie?.value).toBe('')
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

  it('should not clear cookies when expiresAt is missing (treat as valid)', async () => {
    const sessionWithoutExpiry = {
      ...validSession,
      expiresAt: undefined,
    }
    const request = createRequest({
      [COOKIE_NAMES.SESSION]: JSON.stringify(sessionWithoutExpiry),
    })
    const response = await updateSession(request)

    // No Set-Cookie headers should be added
    const setCookieHeader = response.headers.get('set-cookie')
    expect(setCookieHeader).toBeNull()
  })
})
