import { beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/auth/twitch/check-subscription/route'
import { validateCSRFToken } from '@/lib/csrf'
import { getSession } from '@/lib/session'
import { checkRateLimit, getRateLimitIdentifier } from '@/lib/rate-limit'
import { hasScope } from '@/lib/twitch/token-manager'
import { checkTwitchSubViaApi, isTwitchSubCheckEnabled } from '@/lib/twitch/sub-check'

vi.mock('@/lib/csrf')
vi.mock('@/lib/session')
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(),
  getRateLimitIdentifier: vi.fn(),
  rateLimits: { twitchCheckSubscription: {} },
}))
vi.mock('@/lib/twitch/token-manager', () => ({
  hasScope: vi.fn(),
  removeScope: vi.fn(),
}))
vi.mock('@/lib/twitch/sub-check', () => ({
  checkTwitchSubViaApi: vi.fn(),
  isTwitchSubCheckEnabled: vi.fn(),
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
const mockHasScope = vi.mocked(hasScope)
const mockCheckTwitchSubViaApi = vi.mocked(checkTwitchSubViaApi)
const mockIsTwitchSubCheckEnabled = vi.mocked(isTwitchSubCheckEnabled)

function createRequest(): Request {
  return new Request('http://localhost:3000/api/auth/twitch/check-subscription', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': 'token',
    },
  })
}

function createSupabaseMock(options: {
  upsertResult: { data: unknown; error: unknown }
  readBackResult?: { data: unknown; error: unknown }
}) {
  const { upsertResult, readBackResult = upsertResult } = options

  const upsertMaybeSingle = vi.fn().mockResolvedValue(upsertResult)
  const upsertSelect = vi.fn().mockReturnValue({ maybeSingle: upsertMaybeSingle })
  const upsert = vi.fn().mockReturnValue({ select: upsertSelect })

  const readBackMaybeSingle = vi.fn().mockResolvedValue(readBackResult)
  const readBackEq = vi.fn().mockReturnValue({ maybeSingle: readBackMaybeSingle })
  const readBackSelect = vi.fn().mockReturnValue({ eq: readBackEq })

  const from = vi.fn().mockReturnValue({ upsert, select: readBackSelect })
  return { from }
}

describe('POST /api/auth/twitch/check-subscription', () => {
  beforeEach(async () => {
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
    mockCheckRateLimit.mockResolvedValue({ success: true, limit: 5, remaining: 4, reset: Date.now() + 60_000 })
    mockHasScope.mockResolvedValue(true)
    mockCheckTwitchSubViaApi.mockResolvedValue({ hasSub: true, authError: false })
    mockIsTwitchSubCheckEnabled.mockReturnValue(true)
  })

  it('返却行が空かつ再読込で確認できない場合は saved=false を返す', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue(
      createSupabaseMock({
        upsertResult: {
          data: null,
          error: null,
        },
        readBackResult: {
          data: null,
          error: null,
        },
      }) as any
    )

    const response = await POST(createRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ success: true, hasSub: true, saved: false, saveFailureCode: 'NO_ROW_RETURNED' })
  })

  it('返却行が空でも再読込で保存を確認できれば saved=true を返す', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue(
      createSupabaseMock({
        upsertResult: {
          data: null,
          error: null,
        },
        readBackResult: {
          data: {
            twitch_has_sub: true,
            twitch_sub_verified_at: new Date().toISOString(),
          },
          error: null,
        },
      }) as any
    )

    const response = await POST(createRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ success: true, hasSub: true, saved: true })
  })

  it('保存エラー時は500を返す', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue(
      createSupabaseMock({
        upsertResult: {
          data: null,
          error: { code: 'PGRST000', message: 'db error' },
        },
      }) as any
    )

    const response = await POST(createRequest())
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body).toEqual({ error: 'Failed to save subscription status' })
  })

  it('PGRST204（スキーマ未適用）時は保存をスキップして成功を返す', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue(
      createSupabaseMock({
        upsertResult: {
          data: null,
          error: { code: 'PGRST204', message: 'column not found' },
        },
      }) as any
    )

    const response = await POST(createRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ success: true, hasSub: true, saved: false, saveFailureCode: 'PGRST204' })
  })

  it('保存成功時は saved=true を返す', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue(
      createSupabaseMock({
        upsertResult: {
          data: { twitch_user_id: '123456789' },
          error: null,
        },
      }) as any
    )

    const response = await POST(createRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ success: true, hasSub: true, saved: true })
  })
})
