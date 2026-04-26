import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/support/deactivate/route'
import { getSession } from '@/lib/session'
import { validateCSRFToken } from '@/lib/csrf'
import { ERROR_MESSAGES } from '@/lib/constants'

vi.mock('@/lib/session')
vi.mock('@/lib/csrf')
vi.mock('@/lib/logger')
vi.mock('@/lib/sentry/error-handler')
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: Date.now() + 60000 }),
  rateLimits: { deactivatePlan: {} },
  getRateLimitIdentifier: vi.fn().mockResolvedValue('user:user123'),
}))
vi.mock('@/lib/supabase/admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/admin')>()
  return {
    ...actual,
    getSupabaseAdmin: vi.fn(),
  }
})

const mockGetSession = vi.mocked(getSession)
const mockValidateCSRFToken = vi.mocked(validateCSRFToken)

function createRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/support/deactivate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
  })
}

describe('POST /api/support/deactivate', () => {
  beforeEach(async () => {
    vi.clearAllMocks()

    // clearAllMocks後にレート制限モックを再設定
    const { checkRateLimit, getRateLimitIdentifier } = await import('@/lib/rate-limit')
    vi.mocked(checkRateLimit).mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: Date.now() + 60000 })
    vi.mocked(getRateLimitIdentifier).mockResolvedValue('user:user123')

    mockGetSession.mockResolvedValue({
      twitchUserId: 'user123',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/avatar.jpg',
      broadcasterType: '',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: 1,
    })
    mockValidateCSRFToken.mockResolvedValue({ valid: true })
  })

  it('should return 403 when CSRF token is invalid', async () => {
    mockValidateCSRFToken.mockResolvedValue({ valid: false })
    const response = await POST(createRequest())
    expect(response.status).toBe(403)
    const data = await response.json()
    expect(data.error).toBe(ERROR_MESSAGES.FORBIDDEN)
  })

  it('should return 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValue(null)
    const response = await POST(createRequest())
    expect(response.status).toBe(401)
    const data = await response.json()
    expect(data.error).toBe(ERROR_MESSAGES.UNAUTHORIZED)
  })

  it('should return 429 when rate limit exceeded', async () => {
    const { checkRateLimit } = await import('@/lib/rate-limit')
    vi.mocked(checkRateLimit).mockResolvedValue({
      success: false,
      limit: 5,
      remaining: 0,
      reset: Date.now() + 30000,
    })

    const response = await POST(createRequest())
    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBeTruthy()
  })

  it('should return 200 and planType basic on success', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({
      rpc: vi.fn().mockResolvedValue({
        data: { success: true, deleted_count: 2 },
        error: null,
      }),
    } as any)

    const response = await POST(createRequest())
    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.success).toBe(true)
    expect(data.planType).toBe('basic')
  })

  it('should return 200 even when no licenses exist (idempotent)', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({
      rpc: vi.fn().mockResolvedValue({
        data: { success: true, deleted_count: 0 },
        error: null,
      }),
    } as any)

    const response = await POST(createRequest())
    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.success).toBe(true)
    expect(data.planType).toBe('basic')
  })

  it('should return 500 when RPC fails', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'DB error', code: '500' },
      }),
    } as any)

    const response = await POST(createRequest())
    expect(response.status).toBe(500)
  })

  it('should call RPC with correct parameters', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    const rpcMock = vi.fn().mockResolvedValue({
      data: { success: true, deleted_count: 1 },
      error: null,
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue({ rpc: rpcMock } as any)

    await POST(createRequest())

    expect(rpcMock).toHaveBeenCalledWith('deactivate_all_licenses', {
      p_twitch_user_id: 'user123',
    })
  })
})
