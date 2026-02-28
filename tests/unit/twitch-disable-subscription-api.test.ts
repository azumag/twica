import { beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/auth/twitch/disable-subscription/route'
import { validateCSRFToken } from '@/lib/csrf'
import { getSession } from '@/lib/session'
import { checkRateLimit, getRateLimitIdentifier } from '@/lib/rate-limit'
import { ERROR_MESSAGES } from '@/lib/constants'

vi.mock('@/lib/csrf')
vi.mock('@/lib/session')
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(),
  getRateLimitIdentifier: vi.fn(),
  rateLimits: { twitchDisableSubscription: {} },
}))
vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const mockValidateCSRFToken = vi.mocked(validateCSRFToken)
const mockGetSession = vi.mocked(getSession)
const mockCheckRateLimit = vi.mocked(checkRateLimit)
const mockGetRateLimitIdentifier = vi.mocked(getRateLimitIdentifier)

function createRequest(): Request {
  return new Request('http://localhost:3000/api/auth/twitch/disable-subscription', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': 'token',
    },
  })
}

function createSupabaseMock(updateResult: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn().mockResolvedValue(updateResult)
  const select = vi.fn().mockReturnValue({ maybeSingle })
  const eq = vi.fn().mockReturnValue({ select })
  const update = vi.fn().mockReturnValue({ eq })
  const from = vi.fn().mockReturnValue({ update })

  return {
    from,
    update,
    eq,
    select,
    maybeSingle,
  }
}

describe('POST /api/auth/twitch/disable-subscription', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mockValidateCSRFToken.mockResolvedValue({ valid: true })
    mockGetSession.mockResolvedValue({
      twitchUserId: '123456789',
      twitchUsername: 'test-user',
      twitchDisplayName: 'Test User',
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
  })

  it('CSRF 不正時は 403 を返す', async () => {
    mockValidateCSRFToken.mockResolvedValue({ valid: false })

    const response = await POST(createRequest())
    const body = await response.json()

    expect(response.status).toBe(403)
    expect(body).toEqual({ error: ERROR_MESSAGES.FORBIDDEN })
  })

  it('未認証時は 401 を返す', async () => {
    mockGetSession.mockResolvedValue(null)

    const response = await POST(createRequest())
    const body = await response.json()

    expect(response.status).toBe(401)
    expect(body).toEqual({ error: ERROR_MESSAGES.NOT_AUTHENTICATED })
  })

  it('レート制限超過時は 429 を返す', async () => {
    mockCheckRateLimit.mockResolvedValue({
      success: false,
      limit: 5,
      remaining: 0,
      reset: Date.now() + 60_000,
    })

    const response = await POST(createRequest())
    const body = await response.json()

    expect(response.status).toBe(429)
    expect(body).toEqual({ error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED })
    expect(response.headers.get('X-RateLimit-Limit')).toBe('5')
  })

  it('正常無効化時は 200 を返し far-future を保存する', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    const supabaseMock = createSupabaseMock({
      data: { twitch_user_id: '123456789' },
      error: null,
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue({
      from: supabaseMock.from,
    } as any)

    const response = await POST(createRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({
      success: true,
      hasSub: false,
      twitchSubVerifiedAt: '9999-12-31T00:00:00.000Z',
    })
    expect(supabaseMock.update).toHaveBeenCalledWith({
      twitch_has_sub: false,
      twitch_sub_verified_at: '9999-12-31T00:00:00.000Z',
    })
    expect(supabaseMock.eq).toHaveBeenCalledWith('twitch_user_id', '123456789')
  })

  it('DB エラー時は 500 を返す', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({
      from: createSupabaseMock({
        data: null,
        error: { code: 'PGRST000', message: 'db error' },
      }).from,
    } as any)

    const response = await POST(createRequest())
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body).toEqual({ error: 'Failed to disable subscription status' })
  })
})
