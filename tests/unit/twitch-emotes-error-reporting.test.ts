import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/session', () => ({
  getSession: vi.fn(),
  canUseStreamerFeatures: vi.fn(),
}))

vi.mock('@/lib/rate-limit', () => ({
  getRateLimitIdentifier: vi.fn().mockResolvedValue('user:test'),
  checkRateLimit: vi.fn(),
  rateLimits: { twitchRewardsGet: { windowMs: 60_000, max: 30 } },
}))

vi.mock('@/lib/twitch/token-manager', () => ({
  getTwitchAccessToken: vi.fn(),
  twitchTokenErrorReportContext: vi.fn(),
}))

vi.mock('@/lib/error-handler', () => ({
  handleApiError: vi.fn(),
}))

describe('GET /api/twitch/emotes error reporting', () => {
  beforeEach(async () => {
    vi.clearAllMocks()

    const { getSession, canUseStreamerFeatures } = await import('@/lib/session')
    const { checkRateLimit } = await import('@/lib/rate-limit')

    vi.mocked(getSession).mockResolvedValue({ twitchUserId: 'streamer-1' } as never)
    vi.mocked(canUseStreamerFeatures).mockReturnValue(true)
    vi.mocked(checkRateLimit).mockResolvedValue({
      success: true,
      limit: 30,
      remaining: 29,
      reset: Date.now() + 60_000,
    })
  })

  it('token refresh失敗時の診断contextをhandleApiErrorへ渡す', async () => {
    const tokenError = new Error('refresh failed')
    const reportContext = {
      refreshStatus: 503,
      refreshErrorKind: 'http',
      refreshRetryable: true,
    }

    const { getTwitchAccessToken, twitchTokenErrorReportContext } =
      await import('@/lib/twitch/token-manager')
    const { handleApiError } = await import('@/lib/error-handler')

    vi.mocked(getTwitchAccessToken).mockRejectedValue(tokenError)
    vi.mocked(twitchTokenErrorReportContext).mockReturnValue(reportContext)
    vi.mocked(handleApiError).mockResolvedValue(
      new Response(JSON.stringify({ error: 'handled' }), { status: 500 }) as never
    )

    const { GET } = await import('@/app/api/twitch/emotes/route')
    await GET(new Request('http://localhost:3000/api/twitch/emotes'))

    expect(twitchTokenErrorReportContext).toHaveBeenCalledWith(tokenError)
    expect(handleApiError).toHaveBeenCalledWith(
      tokenError,
      'Twitch emotes fetch',
      reportContext
    )
  })
})
