import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockCookieStore = {
  get: vi.fn(),
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => mockCookieStore),
}))

vi.mock('@/lib/logger', () => ({
  logger,
}))

describe('getSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SESSION_COOKIE_SECRET = 'test-secret-key-32-chars-abcdefgh'
  })

  it('warns instead of logging an error for unsigned legacy cookies', async () => {
    mockCookieStore.get.mockReturnValue({
      value: JSON.stringify({
        twitchUserId: '12345',
        twitchUsername: 'testuser',
        twitchDisplayName: 'Test User',
        twitchProfileImageUrl: 'https://example.com/image.png',
        broadcasterType: 'affiliate',
        expiresAt: Date.now() + 60_000,
        version: 1,
      }),
    })

    const { getSession } = await import('@/lib/session')
    await expect(getSession()).resolves.toBeNull()

    expect(logger.warn).toHaveBeenCalledWith('[Session] Ignoring invalid session cookie', {
      reason: 'Session cookie is not signed',
    })
    expect(logger.error).not.toHaveBeenCalled()
  })
})
