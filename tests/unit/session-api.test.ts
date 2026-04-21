import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GET } from '@/app/api/session/route'
import { getSession } from '@/lib/session'
import { setCSRFToken } from '@/lib/csrf'
import { ERROR_MESSAGES } from '@/lib/constants'

vi.mock('@/lib/session', () => ({
  getSession: vi.fn(),
}))

vi.mock('@/lib/csrf', () => ({
  setCSRFToken: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const mockGetSession = vi.mocked(getSession)
const mockSetCSRFToken = vi.mocked(setCSRFToken)

describe('GET /api/session', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('認証済みセッションでは CSRF トークンを再発行してレスポンスヘッダーに載せる', async () => {
    mockGetSession.mockResolvedValue({
      twitchUserId: '123',
      twitchUsername: 'user',
      twitchDisplayName: 'User',
      twitchProfileImageUrl: 'https://example.com/avatar.png',
      broadcasterType: 'affiliate',
      expiresAt: Date.now() + 60_000,
      version: 1,
    })
    mockSetCSRFToken.mockResolvedValue('fresh-csrf-token')

    const response = await GET()

    expect(response.status).toBe(200)
    expect(response.headers.get('x-csrf-token')).toBe('fresh-csrf-token')
    await expect(response.json()).resolves.toMatchObject({
      twitchUserId: '123',
    })
  })

  it('未認証時は 401 を返す', async () => {
    mockGetSession.mockResolvedValue(null)

    const response = await GET()

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: ERROR_MESSAGES.NOT_AUTHENTICATED,
    })
    expect(mockSetCSRFToken).not.toHaveBeenCalled()
  })
})
