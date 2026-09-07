import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/gacha/demo/route'
import { getSession } from '@/lib/session'
import { getStreamerIdByTwitchUserId } from '@/lib/user-data'
import { validateCSRFToken } from '@/lib/csrf'
import { checkRateLimit, getRateLimitIdentifier } from '@/lib/rate-limit'
import { ERROR_MESSAGES } from '@/lib/constants'

vi.mock('@/lib/session')
vi.mock('@/lib/user-data')
vi.mock('@/lib/csrf')
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(),
  getRateLimitIdentifier: vi.fn(),
  rateLimits: { gachaDemoBroadcast: {}, gachaDemoCard: {} },
  retryAfterSeconds: vi.fn(),
}))

const mockGetSession = vi.mocked(getSession)
const mockGetStreamerIdByTwitchUserId = vi.mocked(getStreamerIdByTwitchUserId)
const mockValidateCSRFToken = vi.mocked(validateCSRFToken)
const mockCheckRateLimit = vi.mocked(checkRateLimit)
const mockGetRateLimitIdentifier = vi.mocked(getRateLimitIdentifier)

describe('POST /api/gacha/demo: broadcast CSRF gate order', () => {
  it('passes the exact request to CSRF validation and rejects before any rate-limit lookup', async () => {
    mockValidateCSRFToken.mockResolvedValue({ valid: false, error: 'bad csrf' })
    const request = new NextRequest('http://localhost/api/gacha/demo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ streamerId: 'streamer-1', broadcast: true }),
    })

    const response = await POST(request)

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: ERROR_MESSAGES.FORBIDDEN })
    expect(mockValidateCSRFToken).toHaveBeenCalledTimes(1)
    expect(mockValidateCSRFToken).toHaveBeenCalledWith(request)
    expect(mockGetRateLimitIdentifier).not.toHaveBeenCalled()
    expect(mockCheckRateLimit).not.toHaveBeenCalled()
    expect(mockGetSession).not.toHaveBeenCalled()
    expect(mockGetStreamerIdByTwitchUserId).not.toHaveBeenCalled()
  })
})
