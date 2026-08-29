import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { ERROR_MESSAGES } from '@/lib/constants'
import type { Session } from '@/lib/session'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/logger.server', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/perf', () => ({
  perfStart: vi.fn().mockReturnValue(0),
  logPerf: vi.fn(),
}))
vi.mock('@/lib/session', () => ({
  getSession: vi.fn(),
  canUseStreamerFeatures: vi.fn(),
}))
vi.mock('@/lib/rate-limit', () => ({
  getRateLimitIdentifier: vi.fn().mockResolvedValue('user:test'),
  checkRateLimit: vi.fn(),
  rateLimits: { twitchRewardsGet: { windowMs: 60_000, max: 30 } },
}))
vi.mock('@/lib/twitch/token-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/twitch/token-manager')>()
  return {
    ...actual,
    getTwitchAccessToken: vi.fn(),
    hasScope: vi.fn(),
  }
})
vi.mock('@/lib/error-handler', () => ({
  handleApiError: vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ error: 'Internal Server Error' }), { status: 500 }),
  ),
  handleDatabaseError: vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ error: 'Database error' }), { status: 500 }),
  ),
  recordApiError: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/twitch/channel-points-access', () => ({
  getChannelPointsAccessState: vi.fn().mockResolvedValue({
    capability: 'unknown',
    checkedAt: null,
    enabled: false,
  }),
  persistChannelPointsCapability: vi.fn().mockResolvedValue(undefined),
  recordChannelPointsApiFailure: vi.fn().mockResolvedValue(undefined),
}))

const session = {
  twitchUserId: 'streamer-1',
  twitchUsername: 'streamer',
  twitchDisplayName: 'Streamer',
  twitchProfileImageUrl: '',
  broadcasterType: 'affiliate',
  expiresAt: Date.now() + 10_000,
  version: 1,
} satisfies Session

describe('GET /api/twitch/channel-point-bootstrap refresh status contract', () => {
  beforeEach(async () => {
    vi.clearAllMocks()

    const { getSession, canUseStreamerFeatures } = await import('@/lib/session')
    const { checkRateLimit } = await import('@/lib/rate-limit')
    const { hasScope } = await import('@/lib/twitch/token-manager')

    vi.mocked(getSession).mockResolvedValue(session)
    vi.mocked(canUseStreamerFeatures).mockReturnValue(true)
    vi.mocked(checkRateLimit).mockResolvedValue({
      success: true,
      limit: 30,
      remaining: 29,
      reset: Date.now() + 60_000,
    })
    vi.mocked(hasScope).mockResolvedValue(true)
  })

  // Issue #1258: route側の既存テストは permanent 判定と診断helperを同形mockで
  // 供給するため、ここでは実helperを残したpartial mockで、400/401の
  // ホワイトリスト・401応答・エラー記録コンテキストを一続きに固定する。
  it.each([400, 401])(
    'REFRESH_FAILED(status=%i, kind=http)は実 helper 経由で401+requiresReauthへ変換する',
    async (refreshStatus) => {
      const {
        getTwitchAccessToken,
        isPermanentRefreshFailure,
        TwitchTokenError,
      } = await import('@/lib/twitch/token-manager')
      const { handleApiError, recordApiError } = await import('@/lib/error-handler')
      const { recordChannelPointsApiFailure } = await import('@/lib/twitch/channel-points-access')

      const tokenError = new TwitchTokenError(
        'Failed to refresh Twitch access token',
        'REFRESH_FAILED',
        undefined,
        refreshStatus,
        'http',
        false,
      )
      expect(isPermanentRefreshFailure(tokenError)).toBe(true)
      vi.mocked(getTwitchAccessToken).mockRejectedValue(tokenError)

      const { GET } = await import('@/app/api/twitch/channel-point-bootstrap/route')
      const response = await GET(
        new NextRequest('http://localhost:3000/api/twitch/channel-point-bootstrap'),
      )
      const body = await response.json()

      expect(response.status).toBe(401)
      expect(body).toEqual({
        error: ERROR_MESSAGES.TWITCH_TOKEN_REQUIRED,
        requiresReauth: true,
      })
      expect(recordApiError).toHaveBeenCalledWith(
        tokenError,
        'Channel Point Bootstrap API',
        {
          refreshStatus,
          refreshErrorKind: 'http',
          refreshRetryable: false,
        },
      )
      expect(recordChannelPointsApiFailure).toHaveBeenCalledWith('streamer-1', 401)
      expect(handleApiError).not.toHaveBeenCalled()
    },
  )

  // 403はWAF/client設定、520は上流一時障害になり得るため、retryable=falseでも
  // 400/401以外を恒久失効と扱って401+requiresReauthへ広げない。
  it.each([403, 520])(
    'REFRESH_FAILED(status=%i, kind=http)は実 helper 経由で500を維持する',
    async (refreshStatus) => {
      const {
        getTwitchAccessToken,
        isPermanentRefreshFailure,
        TwitchTokenError,
      } = await import('@/lib/twitch/token-manager')
      const { handleApiError, recordApiError } = await import('@/lib/error-handler')
      const { recordChannelPointsApiFailure } = await import('@/lib/twitch/channel-points-access')

      const tokenError = new TwitchTokenError(
        'Failed to refresh Twitch access token',
        'REFRESH_FAILED',
        undefined,
        refreshStatus,
        'http',
        false,
      )
      expect(isPermanentRefreshFailure(tokenError)).toBe(false)
      vi.mocked(getTwitchAccessToken).mockRejectedValue(tokenError)

      const { GET } = await import('@/app/api/twitch/channel-point-bootstrap/route')
      const response = await GET(
        new NextRequest('http://localhost:3000/api/twitch/channel-point-bootstrap'),
      )

      expect(response.status).toBe(500)
      expect(handleApiError).toHaveBeenCalledWith(
        tokenError,
        'Channel Point Bootstrap API',
        {
          refreshStatus,
          refreshErrorKind: 'http',
          refreshRetryable: false,
        },
      )
      expect(recordApiError).not.toHaveBeenCalled()
      expect(recordChannelPointsApiFailure).not.toHaveBeenCalled()
    },
  )
})
