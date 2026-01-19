import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/streamer/settings/route'
import { getSession } from '@/lib/session'
import { checkRateLimit } from '@/lib/rate-limit'
import { validateCSRFToken } from '@/lib/csrf'
import { validateContentType } from '@/lib/request-validation'

vi.mock('@/lib/session')
vi.mock('@/lib/rate-limit')
vi.mock('@/lib/csrf')
vi.mock('@/lib/request-validation')
vi.mock('@/lib/constants')

const mockGetSession = vi.mocked(getSession)
const mockCheckRateLimit = vi.mocked(checkRateLimit)
const mockValidateCSRFToken = vi.mocked(validateCSRFToken)
const mockValidateContentType = vi.mocked(validateContentType)

describe('POST /api/streamer/settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    
    mockGetSession.mockResolvedValue({
      twitchUserId: 'streamer123',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/avatar.jpg',
      broadcasterType: 'affiliate',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: 1,
    })
    
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Date.now() + 60000,
    })
    
    mockValidateCSRFToken.mockResolvedValue({ valid: true })
    mockValidateContentType.mockReturnValue(null)
  })

  it('should update streamer settings with valid data', async () => {
    const mockSupabaseAdmin = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                id: 'streamer123',
                twitch_user_id: 'streamer123',
              }),
            }),
          }),
        }),
      }),
      update: vi.fn().mockResolvedValue({
        data: { id: 'streamer123' },
        error: null,
      }),
    }

    const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-CSRF-Token': 'test-csrf-token',
      },
      body: JSON.stringify({
        streamerId: 'streamer123',
        channelPointRewardId: 'reward-123',
        channelPointRewardName: 'Test Reward',
      }),
    })

    const response = await POST(request)

    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data).toEqual({ success: true })
    expect(mockSupabaseAdmin.from).toHaveBeenCalledWith('streamers')
    expect(mockSupabaseAdmin.update).toHaveBeenCalled()
  })

  it('should return 403 when CSRF token is invalid', async () => {
    mockValidateCSRFToken.mockResolvedValue({ valid: false })

    const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        streamerId: 'streamer123',
      }),
    })

    const response = await POST(request)

    expect(response.status).toBe(403)
    const data = await response.json()
    expect(data.error).toBe('Forbidden')
  })

  it('should return 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValue(null)

    const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-CSRF-Token': 'test-csrf-token',
      },
      body: JSON.stringify({
        streamerId: 'streamer123',
      }),
    })

    const response = await POST(request)

    expect(response.status).toBe(401)
    const data = await response.json()
    expect(data.error).toBe('Unauthorized')
  })

  it('should return 429 when rate limit exceeded', async () => {
    mockCheckRateLimit.mockResolvedValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 60000,
    })

    const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-CSRF-Token': 'test-csrf-token',
      },
      body: JSON.stringify({
        streamerId: 'streamer123',
      }),
    })

    const response = await POST(request)

    expect(response.status).toBe(429)
    const data = await response.json()
    expect(data.error).toBe('Too many requests. Please try again later.')
  })
})
