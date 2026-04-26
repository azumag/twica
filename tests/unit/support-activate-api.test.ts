import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/support/activate/route'
import { getSession } from '@/lib/session'
import { validateCSRFToken } from '@/lib/csrf'
import { ERROR_MESSAGES, PLAN_CONFIG } from '@/lib/constants'

vi.mock('@/lib/session')
vi.mock('@/lib/csrf')
vi.mock('@/lib/logger')
vi.mock('@/lib/sentry/error-handler')
vi.mock('@/lib/request-validation', () => ({
  validateContentType: vi.fn().mockReturnValue(null),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ success: true, limit: 5, remaining: 4, reset: Date.now() + 60000 }),
  rateLimits: { activateCode: {} },
  getRateLimitIdentifier: vi.fn().mockResolvedValue('user:user123'),
}))
vi.mock('@/lib/supabase/admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/admin')>()
  return {
    ...actual,
    getSupabaseAdmin: vi.fn(),
  }
})
vi.mock('@/lib/crypto-utils', () => ({
  sha256: vi.fn().mockResolvedValue('hashed-code-value'),
}))

const mockGetSession = vi.mocked(getSession)
const mockValidateCSRFToken = vi.mocked(validateCSRFToken)

function createRequest(body: Record<string, unknown> = { code: 'test-code-123' }): NextRequest {
  return new NextRequest('http://localhost:3000/api/support/activate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

describe('POST /api/support/activate', () => {
  beforeEach(async () => {
    vi.clearAllMocks()

    // clearAllMocks後にレート制限モックを再設定
    const { checkRateLimit, getRateLimitIdentifier } = await import('@/lib/rate-limit')
    vi.mocked(checkRateLimit).mockResolvedValue({ success: true, limit: 5, remaining: 4, reset: Date.now() + 60000 })
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

    // sha256モックも再設定
    const { sha256 } = await import('@/lib/crypto-utils')
    vi.mocked(sha256).mockResolvedValue('hashed-code-value')
  })

  it('should return 403 when CSRF token is invalid', async () => {
    mockValidateCSRFToken.mockResolvedValue({ valid: false })
    const response = await POST(createRequest())
    expect(response.status).toBe(403)
  })

  it('should return 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValue(null)
    const response = await POST(createRequest())
    expect(response.status).toBe(401)
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

  it('should return 400 when code is missing', async () => {
    const response = await POST(createRequest({ code: '' }))
    expect(response.status).toBe(400)
    const data = await response.json()
    expect(data.error).toBe(ERROR_MESSAGES.SUPPORT_CODE_REQUIRED)
  })

  it('should return 400 when code exceeds max length', async () => {
    const longCode = 'a'.repeat(PLAN_CONFIG.CODE_MAX_LENGTH + 1)
    const response = await POST(createRequest({ code: longCode }))
    expect(response.status).toBe(400)
    const data = await response.json()
    expect(data.error).toBe(ERROR_MESSAGES.SUPPORT_CODE_TOO_LONG)
  })

  it('should return 400 when fanboxId exceeds max length', async () => {
    const longFanboxId = 'a'.repeat(PLAN_CONFIG.FANBOX_ID_MAX_LENGTH + 1)
    const response = await POST(createRequest({ code: 'valid-code', fanboxId: longFanboxId }))
    expect(response.status).toBe(400)
    const data = await response.json()
    expect(data.error).toBe(ERROR_MESSAGES.FANBOX_ID_TOO_LONG)
  })

  it('should return success when RPC succeeds', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({
      rpc: vi.fn().mockResolvedValue({
        data: { success: true, plan_type: 'support' },
        error: null,
      }),
    } as any)

    const response = await POST(createRequest())
    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.success).toBe(true)
    expect(data.planType).toBe('support')
  })

  it('should return 404 for INVALID_CODE RPC error', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({
      rpc: vi.fn().mockResolvedValue({
        data: { error: 'INVALID_CODE' },
        error: null,
      }),
    } as any)

    const response = await POST(createRequest())
    expect(response.status).toBe(404)
    const data = await response.json()
    expect(data.error).toBe(ERROR_MESSAGES.INVALID_SUPPORT_CODE)
  })

  it('should return 410 for CODE_REVOKED RPC error', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({
      rpc: vi.fn().mockResolvedValue({
        data: { error: 'CODE_REVOKED' },
        error: null,
      }),
    } as any)

    const response = await POST(createRequest())
    expect(response.status).toBe(410)
  })

  it('should return 409 for ALREADY_ACTIVATED RPC error', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({
      rpc: vi.fn().mockResolvedValue({
        data: { error: 'ALREADY_ACTIVATED' },
        error: null,
      }),
    } as any)

    const response = await POST(createRequest())
    expect(response.status).toBe(409)
    const data = await response.json()
    expect(data.error).toBe(ERROR_MESSAGES.SUPPORT_CODE_ALREADY_ACTIVATED)
  })

  it('should return 500 for unknown RPC errors', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({
      rpc: vi.fn().mockResolvedValue({
        data: { error: 'UNKNOWN_ERROR_TYPE' },
        error: null,
      }),
    } as any)

    const response = await POST(createRequest())
    expect(response.status).toBe(500)
  })

  it('should call sha256 with trimmed code before RPC', async () => {
    const { sha256 } = await import('@/lib/crypto-utils')
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    const rpcMock = vi.fn().mockResolvedValue({
      data: { success: true, plan_type: 'support' },
      error: null,
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue({ rpc: rpcMock } as any)

    await POST(createRequest({ code: '  code-with-spaces  ' }))

    expect(sha256).toHaveBeenCalledWith('code-with-spaces')
    expect(rpcMock).toHaveBeenCalledWith('activate_support_code', {
      p_code_hash: 'hashed-code-value',
      p_twitch_user_id: 'user123',
      p_fanbox_id: null,
    })
  })

  it('should pass fanboxId to RPC when provided', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    const rpcMock = vi.fn().mockResolvedValue({
      data: { success: true, plan_type: 'patron' },
      error: null,
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue({ rpc: rpcMock } as any)

    await POST(createRequest({ code: 'test-code', fanboxId: 'my-fanbox-id' }))

    expect(rpcMock).toHaveBeenCalledWith('activate_support_code', {
      p_code_hash: 'hashed-code-value',
      p_twitch_user_id: 'user123',
      p_fanbox_id: 'my-fanbox-id',
    })
  })
})
