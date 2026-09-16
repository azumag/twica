import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  loggerWarn: vi.fn(),
  reportAuthError: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    warn: mocks.loggerWarn,
  },
}))

vi.mock('@/lib/sentry/error-handler', () => ({
  reportAuthError: mocks.reportAuthError,
}))

import { handleAuthError } from '@/lib/auth-error-handler'

describe('handleAuthError', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_APP_URL = 'https://env.example'
  })

  it('永続化対象の認証失敗を warning + reportAuthError で1回記録し JSON 500 を返す', async () => {
    const error = new Error('oauth failed')

    const response = await handleAuthError(
      error,
      'twitch_auth_failed',
      { twitchUserId: 'user-1' },
      { returnJson: true },
    )

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      error: 'twitch_auth_failed',
    })
    expect(mocks.loggerWarn).toHaveBeenCalledTimes(1)
    expect(mocks.reportAuthError).toHaveBeenCalledTimes(1)
    expect(mocks.reportAuthError).toHaveBeenCalledWith(error, {
      provider: 'twitch',
      action: 'twitch-auth-failed',
      userId: 'user-1',
    })
  })

  it('利用者操作で起こり得る validation error は永続化せず JSON 400 を返す', async () => {
    const response = await handleAuthError(
      new Error('state mismatch'),
      'invalid_state',
      undefined,
      { returnJson: true },
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_state',
    })
    expect(mocks.loggerWarn).not.toHaveBeenCalled()
    expect(mocks.reportAuthError).not.toHaveBeenCalled()
  })

  it('redirect では options.baseUrl を環境変数より優先する', async () => {
    const response = await handleAuthError(
      new Error('missing params'),
      'missing_params',
      undefined,
      { baseUrl: 'https://request.example' },
    )

    expect(response.status).toBe(307)
    const location = response.headers.get('location')
    expect(location).not.toBeNull()
    expect(new URL(location as string).origin).toBe('https://request.example')
    expect(mocks.reportAuthError).not.toHaveBeenCalled()
  })

  it('未知の error type は unknown_error / 500 に fail-safe して永続化する', async () => {
    const error = new Error('unexpected')

    const response = await handleAuthError(
      error,
      'not_mapped',
      undefined,
      { returnJson: true },
    )

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      error: 'unknown_error',
    })
    expect(mocks.loggerWarn).toHaveBeenCalledTimes(1)
    expect(mocks.reportAuthError).toHaveBeenCalledTimes(1)
  })
})
