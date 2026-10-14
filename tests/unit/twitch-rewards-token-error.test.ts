import { beforeEach, describe, expect, it, vi } from 'vitest'

// Issue #1088: emotes / rewards GET・POST / channel-point-bootstrap の token error catch を
// 共通ヘルパへ寄せたことに伴い、rewards 側も「恒久refresh失効は401+requiresReauth、
// 一過性は500」という同一契約になる。ここでは token-manager / error-handler 自体の
// 正当性ではなく、rewards route の結線だけを固定する。
vi.mock('@/lib/session', () => ({
  getSession: vi.fn(),
  canUseStreamerFeatures: vi.fn(),
}))

vi.mock('@/lib/rate-limit', () => ({
  getRateLimitIdentifier: vi.fn().mockResolvedValue('user:test'),
  checkRateLimit: vi.fn(),
  rateLimits: {
    twitchRewardsGet: { windowMs: 60_000, max: 30 },
    twitchRewardsPost: { windowMs: 60_000, max: 10 },
  },
}))

vi.mock('@/lib/csrf', () => ({
  validateCSRFToken: vi.fn().mockResolvedValue({ valid: true }),
}))

vi.mock('@/lib/twitch/token-manager', () => {
  class TwitchTokenError extends Error {
    constructor(
      message: string,
      public readonly code: 'NO_TOKEN' | 'REFRESH_FAILED' | 'DATABASE_ERROR' | 'USER_NOT_FOUND',
      public readonly originalError?: Error,
      public readonly refreshStatus?: number,
      public readonly refreshErrorKind?: string,
      public readonly refreshRetryable?: boolean,
    ) {
      super(message)
      this.name = 'TwitchTokenError'
    }
  }
  const isPermanentRefreshFailure = (error: unknown) =>
    error instanceof TwitchTokenError &&
    error.code === 'REFRESH_FAILED' &&
    error.refreshErrorKind === 'http' &&
    error.refreshStatus !== undefined &&
    [400, 401].includes(error.refreshStatus)
  return {
    TwitchTokenError,
    getTwitchAccessToken: vi.fn(),
    isPermanentRefreshFailure: vi.fn(isPermanentRefreshFailure),
    twitchTokenErrorReportContext: vi.fn(),
  }
})

vi.mock('@/lib/error-handler', () => ({
  handleApiError: vi.fn(),
  recordApiError: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/twitch/channel-points-access', () => ({
  recordChannelPointsApiFailure: vi.fn().mockResolvedValue(undefined),
  persistChannelPointsCapability: vi.fn().mockResolvedValue(undefined),
  getChannelPointsAccessState: vi.fn().mockResolvedValue(null),
}))

describe('/api/twitch/rewards token error contract', () => {
  beforeEach(async () => {
    vi.clearAllMocks()

    const { getSession, canUseStreamerFeatures } = await import('@/lib/session')
    const { checkRateLimit } = await import('@/lib/rate-limit')
    const { validateCSRFToken } = await import('@/lib/csrf')

    vi.mocked(getSession).mockResolvedValue({ twitchUserId: 'streamer-1' } as never)
    vi.mocked(canUseStreamerFeatures).mockReturnValue(true)
    vi.mocked(checkRateLimit).mockResolvedValue({
      success: true,
      limit: 30,
      remaining: 29,
      reset: Date.now() + 60_000,
    })
    vi.mocked(validateCSRFToken).mockResolvedValue({ valid: true } as never)
  })

  it('GET: 恒久refresh失敗(401)は401+requiresReauthを返し、診断context付きで記録する', async () => {
    const { getTwitchAccessToken, TwitchTokenError, twitchTokenErrorReportContext } =
      await import('@/lib/twitch/token-manager')
    const { handleApiError, recordApiError } = await import('@/lib/error-handler')
    const { ERROR_MESSAGES } = await import('@/lib/constants')

    const tokenError = new TwitchTokenError(
      'Failed to refresh Twitch access token',
      'REFRESH_FAILED',
      undefined,
      401,
      'http',
      false,
    )
    const reportContext = { refreshStatus: 401, refreshErrorKind: 'http', refreshRetryable: false }
    vi.mocked(getTwitchAccessToken).mockRejectedValue(tokenError)
    vi.mocked(twitchTokenErrorReportContext).mockReturnValue(reportContext)

    const { GET } = await import('@/app/api/twitch/rewards/route')
    const response = await GET(new Request('http://localhost:3000/api/twitch/rewards'))

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: ERROR_MESSAGES.TWITCH_TOKEN_REQUIRED,
      requiresReauth: true,
    })
    expect(recordApiError).toHaveBeenCalledWith(tokenError, 'Twitch rewards fetch', reportContext)
    expect(handleApiError).not.toHaveBeenCalled()
  })

  it('GET: 一過性refresh失敗(522)は500(handleApiError)を維持する', async () => {
    const { getTwitchAccessToken, TwitchTokenError } = await import('@/lib/twitch/token-manager')
    const { handleApiError, recordApiError } = await import('@/lib/error-handler')

    vi.mocked(getTwitchAccessToken).mockRejectedValue(
      new TwitchTokenError(
        'Failed to refresh Twitch access token',
        'REFRESH_FAILED',
        undefined,
        522,
        'http',
        false,
      ),
    )
    vi.mocked(handleApiError).mockResolvedValue(
      new Response(JSON.stringify({ error: 'handled' }), { status: 500 }) as never
    )

    const { GET } = await import('@/app/api/twitch/rewards/route')
    const response = await GET(new Request('http://localhost:3000/api/twitch/rewards'))

    expect(response.status).toBe(500)
    expect(handleApiError).toHaveBeenCalled()
    expect(recordApiError).not.toHaveBeenCalled()
  })

  it('GET: トークン未保持は記録せず401+requiresReauthを返す', async () => {
    const { getTwitchAccessToken } = await import('@/lib/twitch/token-manager')
    const { handleApiError, recordApiError } = await import('@/lib/error-handler')
    const { ERROR_MESSAGES } = await import('@/lib/constants')

    vi.mocked(getTwitchAccessToken).mockResolvedValue(null)

    const { GET } = await import('@/app/api/twitch/rewards/route')
    const response = await GET(new Request('http://localhost:3000/api/twitch/rewards'))

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: ERROR_MESSAGES.TWITCH_TOKEN_REQUIRED,
      requiresReauth: true,
    })
    expect(recordApiError).not.toHaveBeenCalled()
    expect(handleApiError).not.toHaveBeenCalled()
  })

  it('POST: 恒久refresh失敗(400)も401+requiresReauthへ揃う', async () => {
    const { getTwitchAccessToken, TwitchTokenError, twitchTokenErrorReportContext } =
      await import('@/lib/twitch/token-manager')
    const { handleApiError, recordApiError } = await import('@/lib/error-handler')
    const { ERROR_MESSAGES } = await import('@/lib/constants')

    const tokenError = new TwitchTokenError(
      'Failed to refresh Twitch access token',
      'REFRESH_FAILED',
      undefined,
      400,
      'http',
      false,
    )
    vi.mocked(getTwitchAccessToken).mockRejectedValue(tokenError)
    vi.mocked(twitchTokenErrorReportContext).mockReturnValue(undefined)

    const { POST } = await import('@/app/api/twitch/rewards/route')
    const response = await POST(new Request('http://localhost:3000/api/twitch/rewards', { method: 'POST' }))

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: ERROR_MESSAGES.TWITCH_TOKEN_REQUIRED,
      requiresReauth: true,
    })
    expect(recordApiError).toHaveBeenCalledWith(tokenError, 'Twitch reward creation', undefined)
    expect(handleApiError).not.toHaveBeenCalled()
  })
})
