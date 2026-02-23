import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'
import { COOKIE_NAMES } from '@/lib/constants'

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

  it('should preserve expired session cookie and only clear CSRF cookie', async () => {
    // 期限切れセッションCookieはスコープ保持のために残す
    // ログインルートのparseSession()がtwitchUserIdを抽出して追加スコープを保持するため
    // Expired session cookie is preserved for scope preservation during re-login
    // The login route's parseSession() extracts twitchUserId to preserve additional scopes
    const expiredSession = {
      ...validSession,
      expiresAt: Date.now() - 1000, // expired 1 second ago
    }
    const request = createRequest({
      [COOKIE_NAMES.SESSION]: JSON.stringify(expiredSession),
    })
    const response = await updateSession(request)

    // レスポンスにセッションCookieのSet-Cookieヘッダーが含まれない
    // = ミドルウェアがCookieを書き換えない = ブラウザの既存Cookieがそのまま保持される
    // response.cookies.get() returns undefined means no Set-Cookie header for this cookie
    // = middleware doesn't modify it = browser's existing cookie is preserved
    const sessionCookie = response.cookies.get(COOKIE_NAMES.SESSION)
    expect(sessionCookie).toBeUndefined()

    // CSRFトークンは削除される（期限切れセッションでは不要）
    // CSRF cookie should be cleared (not needed for expired session)
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

  it('should preserve session cookie even when expired for a long time', async () => {
    // 長期間経過した期限切れセッションもスコープ保持のために残す
    // Even long-expired sessions are preserved for scope preservation
    const longExpiredSession = {
      ...validSession,
      expiresAt: Date.now() - 20 * 24 * 60 * 60 * 1000, // expired 20 days ago
    }
    const request = createRequest({
      [COOKIE_NAMES.SESSION]: JSON.stringify(longExpiredSession),
    })
    const response = await updateSession(request)

    // レスポンスにSet-Cookieなし = ミドルウェアが書き換えない = 既存Cookie保持
    // No Set-Cookie in response = middleware doesn't modify = existing cookie preserved
    const sessionCookie = response.cookies.get(COOKIE_NAMES.SESSION)
    expect(sessionCookie).toBeUndefined()

    // CSRFトークンのみ削除される
    // Only CSRF cookie should be cleared
    const csrfCookie = response.cookies.get(COOKIE_NAMES.CSRF_TOKEN)
    expect(csrfCookie?.value).toBe('')
  })
})
