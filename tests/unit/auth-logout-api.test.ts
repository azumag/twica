import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as logoutRoute from '@/app/api/auth/logout/route'
import { validateCSRFToken, clearCSRFToken } from '@/lib/csrf'
import { getSession, clearSession } from '@/lib/session'
import { deleteTwitchTokens } from '@/lib/twitch/token-manager'
import { checkRateLimit, getRateLimitIdentifier } from '@/lib/rate-limit'
import { ERROR_MESSAGES } from '@/lib/constants'

// Issue #399: GET /api/auth/logout は状態変更を行わないこと（GET ハンドラが未定義）を確認し、
// POST ハンドラが CSRF 検証と Twitch token 削除を行うことを検証する。

vi.mock('@/lib/csrf', () => ({
  validateCSRFToken: vi.fn(),
  clearCSRFToken: vi.fn(),
}))
vi.mock('@/lib/session', () => ({
  getSession: vi.fn(),
  clearSession: vi.fn(),
}))
vi.mock('@/lib/twitch/token-manager', () => ({
  deleteTwitchTokens: vi.fn(),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(),
  getRateLimitIdentifier: vi.fn(),
  rateLimits: { authLogout: {} },
}))
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))
vi.mock('@/lib/url-utils', () => ({
  getBaseUrl: vi.fn(() => 'http://localhost:3000'),
}))

const mockValidateCSRFToken = vi.mocked(validateCSRFToken)
const mockClearCSRFToken = vi.mocked(clearCSRFToken)
const mockGetSession = vi.mocked(getSession)
const mockClearSession = vi.mocked(clearSession)
const mockDeleteTwitchTokens = vi.mocked(deleteTwitchTokens)
const mockCheckRateLimit = vi.mocked(checkRateLimit)
const mockGetRateLimitIdentifier = vi.mocked(getRateLimitIdentifier)

function createPostRequest(): Request {
  return new Request('http://localhost:3000/api/auth/logout', {
    method: 'POST',
  })
}

describe('POST /api/auth/logout (issue #399)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockValidateCSRFToken.mockResolvedValue({ valid: true })
    mockGetSession.mockResolvedValue({
      twitchUserId: '123456789',
      twitchUsername: 'user',
      twitchDisplayName: 'User',
      twitchProfileImageUrl: 'https://example.com/avatar.png',
      broadcasterType: 'affiliate',
      expiresAt: Date.now() + 60_000,
      version: 1,
    })
    mockGetRateLimitIdentifier.mockResolvedValue('user:123456789')
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 5,
      remaining: 4,
      reset: Date.now() + 60_000,
    })
    mockDeleteTwitchTokens.mockResolvedValue()
    mockClearSession.mockResolvedValue()
    mockClearCSRFToken.mockResolvedValue()
  })

  it('CSRF 不正時は 403 を返し、セッション破棄やトークン削除を行わない', async () => {
    mockValidateCSRFToken.mockResolvedValue({ valid: false, error: 'bad csrf' })

    const response = await logoutRoute.POST(createPostRequest())

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: ERROR_MESSAGES.FORBIDDEN })
    expect(mockClearSession).not.toHaveBeenCalled()
    expect(mockClearCSRFToken).not.toHaveBeenCalled()
    expect(mockDeleteTwitchTokens).not.toHaveBeenCalled()
  })

  it('CSRF 有効時は Twitch token を削除しセッションとCSRFをクリアしてリダイレクトする', async () => {
    const response = await logoutRoute.POST(createPostRequest())

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('http://localhost:3000/')
    expect(mockDeleteTwitchTokens).toHaveBeenCalledWith('123456789')
    expect(mockClearSession).toHaveBeenCalledTimes(1)
    expect(mockClearCSRFToken).toHaveBeenCalledTimes(1)
  })

  it('レート制限超過時は 429 を返す', async () => {
    mockCheckRateLimit.mockResolvedValue({
      success: false,
      limit: 5,
      remaining: 0,
      reset: Date.now() + 60_000,
    })

    const response = await logoutRoute.POST(createPostRequest())

    expect(response.status).toBe(429)
    await expect(response.json()).resolves.toEqual({ error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED })
    expect(mockClearSession).not.toHaveBeenCalled()
  })
})

describe('GET /api/auth/logout (issue #399)', () => {
  it('GET ハンドラが export されていない（Next.js が自動で 405 を返す設計）', () => {
    // Issue #399: GET による状態変更を完全に廃止するため、GET ハンドラは export しない。
    // Next.js Route Handler は未定義メソッドのリクエストに対して自動で 405 Method Not Allowed を返す。
    expect((logoutRoute as Record<string, unknown>).GET).toBeUndefined()
  })
})
