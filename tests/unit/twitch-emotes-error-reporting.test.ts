import { beforeEach, describe, expect, it, vi } from 'vitest'

// Issue #1088: このテストは token-manager / error-handler 自体の正当性ではなく、
// emotes route が refresh error と診断 context を API 境界へ結線する契約だけを固定する。
// helper / error writer の内部契約は各専用テストへ委ねるため、ここでは意図的に mock する。
vi.mock('@/lib/session', () => ({
  getSession: vi.fn(),
  canUseStreamerFeatures: vi.fn(),
}))

vi.mock('@/lib/rate-limit', () => ({
  getRateLimitIdentifier: vi.fn().mockResolvedValue('user:test'),
  checkRateLimit: vi.fn(),
  rateLimits: { twitchRewardsGet: { windowMs: 60_000, max: 30 } },
}))

vi.mock('@/lib/twitch/token-manager', () => {
  // Issue #1088: routeはinstanceofで再認証要エラーを判定するため、モックにも
  // 実クラスと同形のTwitchTokenErrorを供給する（無いとinstanceof undefinedで
  // TypeErrorになる）。
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
  // 恒久失効判定は実装(twitch-token-manager.test.tsで直接検証)と同一セマンティクスを
  // モッククラスに対して供給する。
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
    const { handleApiError, recordApiError } = await import('@/lib/error-handler')
    const { checkRateLimit, rateLimits } = await import('@/lib/rate-limit')

    vi.mocked(getTwitchAccessToken).mockRejectedValue(tokenError)
    vi.mocked(twitchTokenErrorReportContext).mockReturnValue(reportContext)
    vi.mocked(handleApiError).mockResolvedValue(
      new Response(JSON.stringify({ error: 'handled' }), { status: 500 }) as never
    )

    const { GET } = await import('@/app/api/twitch/emotes/route')
    await GET(new Request('http://localhost:3000/api/twitch/emotes'))

    expect(checkRateLimit).toHaveBeenCalledWith(rateLimits.twitchRewardsGet, 'user:test')
    expect(twitchTokenErrorReportContext).toHaveBeenCalledWith(tokenError)
    expect(handleApiError).toHaveBeenCalledWith(
      tokenError,
      'Twitch emotes fetch',
      reportContext
    )
    // 恒久失効でないため401契約の明示記録経路は使わない。
    expect(recordApiError).not.toHaveBeenCalled()
  })

  it('診断contextがないrefresh失敗でもundefinedをhandleApiErrorへ渡す', async () => {
    const tokenError = new Error('refresh failed without diagnostics')

    const { getTwitchAccessToken, twitchTokenErrorReportContext } =
      await import('@/lib/twitch/token-manager')
    const { handleApiError } = await import('@/lib/error-handler')

    vi.mocked(getTwitchAccessToken).mockRejectedValue(tokenError)
    vi.mocked(twitchTokenErrorReportContext).mockReturnValue(undefined)
    vi.mocked(handleApiError).mockResolvedValue(
      new Response(JSON.stringify({ error: 'handled' }), { status: 500 }) as never
    )

    const { GET } = await import('@/app/api/twitch/emotes/route')
    await GET(new Request('http://localhost:3000/api/twitch/emotes'))

    expect(twitchTokenErrorReportContext).toHaveBeenCalledWith(tokenError)
    expect(handleApiError).toHaveBeenCalledWith(
      tokenError,
      'Twitch emotes fetch',
      undefined
    )
  })

  // Issue #1088 / #1018: 恒久refresh失敗(REFRESH_FAILEDかつkind='http'で
  // statusが{400,401})は汎用500ではなく、channel-point-bootstrap /
  // rewards と同じ 401+requiresReauth 契約へ揃える。
  it('恒久refresh失敗(400)は401+requiresReauthを返し、診断context付きで記録する', async () => {
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
    const reportContext = {
      refreshStatus: 400,
      refreshErrorKind: 'http',
      refreshRetryable: false,
    }
    vi.mocked(getTwitchAccessToken).mockRejectedValue(tokenError)
    vi.mocked(twitchTokenErrorReportContext).mockReturnValue(reportContext)

    const { GET } = await import('@/app/api/twitch/emotes/route')
    const response = await GET(new Request('http://localhost:3000/api/twitch/emotes'))

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: ERROR_MESSAGES.TWITCH_TOKEN_REQUIRED,
      requiresReauth: true,
    })
    // 401へ倒してもauto-generated bug reportへの記録経路は失わない。
    expect(recordApiError).toHaveBeenCalledWith(
      tokenError,
      'Twitch emotes fetch',
      reportContext
    )
    expect(handleApiError).not.toHaveBeenCalled()
  })

  // Issue #1088: 一過性の5xx(520等)は再認証で回復しないため、従来どおり500を維持する。
  it('一過性refresh失敗(520)は500(handleApiError)を維持し、401契約の記録はしない', async () => {
    const { getTwitchAccessToken, TwitchTokenError } = await import('@/lib/twitch/token-manager')
    const { handleApiError, recordApiError } = await import('@/lib/error-handler')

    vi.mocked(getTwitchAccessToken).mockRejectedValue(
      new TwitchTokenError(
        'Failed to refresh Twitch access token',
        'REFRESH_FAILED',
        undefined,
        520,
        'http',
        false,
      ),
    )
    vi.mocked(handleApiError).mockResolvedValue(
      new Response(JSON.stringify({ error: 'handled' }), { status: 500 }) as never
    )

    const { GET } = await import('@/app/api/twitch/emotes/route')
    const response = await GET(new Request('http://localhost:3000/api/twitch/emotes'))

    expect(response.status).toBe(500)
    expect(handleApiError).toHaveBeenCalled()
    expect(recordApiError).not.toHaveBeenCalled()
  })

  // Issue #1088: トークン未保持(getTwitchAccessToken が null)は再ログインで回復する
  // ユーザー操作状態であり、サーバー障害として記録せず 401+requiresReauth を返す
  // (従来挙動の維持)。
  it('トークン未保持は記録せず401+requiresReauthを返す', async () => {
    const { getTwitchAccessToken, twitchTokenErrorReportContext } =
      await import('@/lib/twitch/token-manager')
    const { handleApiError, recordApiError } = await import('@/lib/error-handler')
    const { ERROR_MESSAGES } = await import('@/lib/constants')

    vi.mocked(getTwitchAccessToken).mockResolvedValue(null)

    const { GET } = await import('@/app/api/twitch/emotes/route')
    const response = await GET(new Request('http://localhost:3000/api/twitch/emotes'))

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: ERROR_MESSAGES.TWITCH_TOKEN_REQUIRED,
      requiresReauth: true,
    })
    expect(recordApiError).not.toHaveBeenCalled()
    expect(handleApiError).not.toHaveBeenCalled()
    expect(twitchTokenErrorReportContext).not.toHaveBeenCalled()
  })
})
