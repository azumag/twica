import { beforeEach, describe, expect, it, vi } from 'vitest'

// Issue #1088: token error catch の共通ヘルパ契約を、実物の token-manager
// (TwitchTokenError / isPermanentRefreshFailure / twitchTokenErrorReportContext) を
// 通して固定する。error writer だけをモックし、PlanetScale への実書き込みを避ける。
vi.mock('@/lib/error-handler', () => ({
  handleApiError: vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ error: 'Internal Server Error' }), { status: 500 }),
  ),
  recordApiError: vi.fn().mockResolvedValue(undefined),
}))

import { ERROR_MESSAGES } from '@/lib/constants'
import { TwitchTokenError } from '@/lib/twitch/token-manager'
import {
  MissingTwitchTokenError,
  handleTwitchTokenError,
  isReauthRequiredTokenError,
  reauthRequiredResponse,
} from '@/lib/twitch/token-error-handler'

function makeRefreshError(
  status?: number,
  kind?: 'network' | 'http' | 'invalid_response',
  retryable?: boolean,
) {
  return new TwitchTokenError(
    'Failed to refresh Twitch access token',
    'REFRESH_FAILED',
    undefined,
    status,
    kind,
    retryable,
  )
}

describe('isReauthRequiredTokenError', () => {
  it('有効なトークンが無い状態(未連携・恒久credential欠落)はtrue', () => {
    expect(isReauthRequiredTokenError(new MissingTwitchTokenError())).toBe(true)
  })

  it('NO_TOKENはtrue', () => {
    expect(isReauthRequiredTokenError(new TwitchTokenError('No Twitch token found', 'NO_TOKEN'))).toBe(
      true,
    )
  })

  it('kind=httpかつstatusが400/401(恒久失効)はtrue', () => {
    expect(isReauthRequiredTokenError(makeRefreshError(400, 'http', false))).toBe(true)
    expect(isReauthRequiredTokenError(makeRefreshError(401, 'http', false))).toBe(true)
  })

  it('一過性失敗(403/429/5xx・Cloudflare系)はfalseを維持する', () => {
    for (const status of [403, 429, 500, 501, 505, 520, 521, 525, 526, 530]) {
      expect(isReauthRequiredTokenError(makeRefreshError(status, 'http', false))).toBe(false)
    }
  })

  it('network・invalid_response・diagnostic未付与(DB起因)・非トークンエラーはfalse', () => {
    expect(isReauthRequiredTokenError(makeRefreshError(undefined, 'network', true))).toBe(false)
    expect(isReauthRequiredTokenError(makeRefreshError(200, 'invalid_response', true))).toBe(false)
    expect(
      isReauthRequiredTokenError(
        new TwitchTokenError('Failed to refresh Twitch access token', 'REFRESH_FAILED'),
      ),
    ).toBe(false)
    expect(
      isReauthRequiredTokenError(
        new TwitchTokenError('db down', 'DATABASE_ERROR', undefined, 401, 'http', false),
      ),
    ).toBe(false)
    expect(isReauthRequiredTokenError(new Error('plain error'))).toBe(false)
    expect(isReauthRequiredTokenError(null)).toBe(false)
    expect(isReauthRequiredTokenError('string error')).toBe(false)
  })
})

describe('reauthRequiredResponse', () => {
  it('401とrequiresReauth bodyを返す', async () => {
    const response = reauthRequiredResponse()

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: ERROR_MESSAGES.TWITCH_TOKEN_REQUIRED,
      requiresReauth: true,
    })
  })
})

describe('handleTwitchTokenError', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('トークン未保持は記録せず401+requiresReauthを返す', async () => {
    const { handleApiError, recordApiError } = await import('@/lib/error-handler')

    const response = await handleTwitchTokenError(new MissingTwitchTokenError(), 'Twitch emotes fetch')

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: ERROR_MESSAGES.TWITCH_TOKEN_REQUIRED,
      requiresReauth: true,
    })
    expect(recordApiError).not.toHaveBeenCalled()
    expect(handleApiError).not.toHaveBeenCalled()
  })

  it('恒久失効はsanitized診断context付きで記録したうえ401を返す', async () => {
    const { handleApiError, recordApiError } = await import('@/lib/error-handler')
    const tokenError = makeRefreshError(401, 'http', false)

    const response = await handleTwitchTokenError(tokenError, 'Twitch emotes fetch')

    expect(response.status).toBe(401)
    expect(recordApiError).toHaveBeenCalledWith(tokenError, 'Twitch emotes fetch', {
      refreshStatus: 401,
      refreshErrorKind: 'http',
      refreshRetryable: false,
    })
    expect(handleApiError).not.toHaveBeenCalled()
  })

  it('一過性失敗はhandleApiError(500)へ委譲し、401契約の記録はしない', async () => {
    const { handleApiError, recordApiError } = await import('@/lib/error-handler')
    const tokenError = makeRefreshError(522, 'http', true)

    const response = await handleTwitchTokenError(tokenError, 'Twitch emotes fetch')

    expect(response.status).toBe(500)
    expect(handleApiError).toHaveBeenCalledWith(tokenError, 'Twitch emotes fetch', {
      refreshStatus: 522,
      refreshErrorKind: 'http',
      refreshRetryable: true,
    })
    expect(recordApiError).not.toHaveBeenCalled()
  })

  it('トークンエラーでない汎用エラーはcontextなしでhandleApiError(500)へ委譲する', async () => {
    const { handleApiError } = await import('@/lib/error-handler')
    const error = new Error('unexpected db failure')

    const response = await handleTwitchTokenError(error, 'Twitch emotes fetch')

    expect(response.status).toBe(500)
    expect(handleApiError).toHaveBeenCalledWith(error, 'Twitch emotes fetch', undefined)
  })
})
