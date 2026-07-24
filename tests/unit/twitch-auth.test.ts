import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/env-validation', () => ({
  getEnvVar: vi.fn((name: string) => {
    const vars: Record<string, string> = {
      NEXT_PUBLIC_TWITCH_CLIENT_ID: 'test-client-id',
      TWITCH_CLIENT_SECRET: 'test-client-secret',
    }
    return vars[name] ?? undefined
  }),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}))

describe('AUTH_SCOPES / ADDITIONAL_SCOPES (Issue #398: least privilege)', () => {
  it('AUTH_SCOPES は本人確認に必要な user:read:email のみ', async () => {
    const { AUTH_SCOPES } = await import('@/lib/twitch/scopes')
    expect(AUTH_SCOPES).toBe('user:read:email')
  })

  it('AUTH_SCOPES にチャネルポイント系スコープが含まれない', async () => {
    const { AUTH_SCOPES } = await import('@/lib/twitch/scopes')
    expect(AUTH_SCOPES).not.toMatch(/channel:read:redemptions/)
    expect(AUTH_SCOPES).not.toMatch(/channel:manage:redemptions/)
  })

  it('ADDITIONAL_SCOPES がチャネルポイント/チャット/サブスクの全step-upスコープを定義', async () => {
    const { ADDITIONAL_SCOPES } = await import('@/lib/twitch/scopes')
    expect(Object.values(ADDITIONAL_SCOPES)).toEqual(
      expect.arrayContaining([
        'user:write:chat',
        'user:read:subscriptions',
        'channel:read:redemptions',
        'channel:manage:redemptions',
      ])
    )
  })

  it('CHANNEL_POINT_SCOPES にチャネルポイント連携に必要な両スコープが含まれる', async () => {
    const { CHANNEL_POINT_SCOPES } = await import('@/lib/twitch/scopes')
    expect(CHANNEL_POINT_SCOPES).toEqual([
      'channel:read:redemptions',
      'channel:manage:redemptions',
    ])
  })

  it('getTwitchAuthUrl: 初回ログインURLにチャネルポイント系スコープが含まれない', async () => {
    const { getTwitchAuthUrl } = await import('@/lib/twitch/auth')
    const url = getTwitchAuthUrl('http://localhost/callback', 'test-state')
    const parsed = new URL(url)
    const scope = parsed.searchParams.get('scope') ?? ''
    expect(scope).toBe('user:read:email')
    expect(scope).not.toMatch(/channel:read:redemptions/)
    expect(scope).not.toMatch(/channel:manage:redemptions/)
  })

  it('getTwitchAuthUrl: additionalScopesで渡せば channel point スコープを含む', async () => {
    const { getTwitchAuthUrl } = await import('@/lib/twitch/auth')
    const { CHANNEL_POINT_SCOPES } = await import('@/lib/twitch/scopes')
    const url = getTwitchAuthUrl('http://localhost/callback', 'test-state', [
      ...CHANNEL_POINT_SCOPES,
    ])
    const parsed = new URL(url)
    const scope = parsed.searchParams.get('scope') ?? ''
    expect(scope).toContain('user:read:email')
    expect(scope).toContain('channel:read:redemptions')
    expect(scope).toContain('channel:manage:redemptions')
  })
})

describe('exchangeCodeForTokens', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('正常系: トークンが正しく返される', async () => {
    const mockTokens = {
      access_token: 'test-access-token',
      refresh_token: 'test-refresh-token',
      expires_in: 3600,
      token_type: 'bearer',
      scope: ['user:read:email'],
    }

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockTokens), { status: 200 })
    )

    const { exchangeCodeForTokens } = await import('@/lib/twitch/auth')
    const result = await exchangeCodeForTokens('test-code', 'http://localhost/callback')

    expect(result).toEqual(mockTokens)
  })

  it('異常系: invalid authorization codeを分類するが、token endpoint本文はErrorへ保持しない', async () => {
    const errorBody = '{"status":400,"message":"Invalid authorization code"}'

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(errorBody, { status: 400, statusText: 'Bad Request' })
    )

    const { exchangeCodeForTokens } = await import('@/lib/twitch/auth')

    await expect(
      exchangeCodeForTokens('expired-code', 'http://localhost/callback')
    ).rejects.toThrow('Authentication failed: 400')

    const { logger } = await import('@/lib/logger')
    expect(logger.warn).toHaveBeenCalledWith(
      'Token exchange rejected: invalid or expired authorization code',
      { status: 400 }
    )
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('異常系: 401 Unauthorizedのエラー情報が含まれる', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"message":"invalid client"}', { status: 401 })
    )

    const { exchangeCodeForTokens } = await import('@/lib/twitch/auth')

    await expect(
      exchangeCodeForTokens('code', 'http://localhost/callback')
    ).rejects.toThrow(/Authentication failed: 401/)
  })

  it('異常系: 500 サーバーエラーのエラー情報が含まれる', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Internal Server Error', { status: 500 })
    )

    const { exchangeCodeForTokens } = await import('@/lib/twitch/auth')

    await expect(
      exchangeCodeForTokens('code', 'http://localhost/callback')
    ).rejects.toThrow('Authentication failed: 500')
  })

  it('522でもauthorization code交換は単回で、再送しない', async () => {
    const secretSentinel = 'SECRET_SENTINEL_FROM_TOKEN_ENDPOINT'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(`error code: 522 ${secretSentinel}`, { status: 522 })
    )
    const { exchangeCodeForTokens } = await import('@/lib/twitch/auth')

    await expect(exchangeCodeForTokens('single-use-code', 'http://localhost/callback'))
      .rejects.toThrow('Authentication failed: 522')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const { logger } = await import('@/lib/logger')
    // callback の reportAuthError だけを永続化点にする。logger.error は自動永続化するため禁止。
    expect(logger.error).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith('Token exchange failed:', { status: 522 })
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(secretSentinel)
  })

  it('2xxの不正token JSONは本文を捨てた固定Errorへ変換する', async () => {
    const secretSentinel = 'SECRET_MALFORMED_EXCHANGE_BODY'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(`{"access_token":"${secretSentinel}"`, { status: 200 })
    )
    const { exchangeCodeForTokens } = await import('@/lib/twitch/auth')

    const error = await exchangeCodeForTokens('code', 'http://localhost/callback')
      .catch(value => value as Error)
    if (!(error instanceof Error)) throw new Error('Expected malformed exchange response to reject')

    expect(error.message).toBe('Authentication failed: invalid token response')
    expect(error.message).not.toContain(secretSentinel)
    const { logger } = await import('@/lib/logger')
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(secretSentinel)
  })

  it('異常系: fetchが失敗した場合はそのまま例外が伝播する', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'))

    const { exchangeCodeForTokens } = await import('@/lib/twitch/auth')

    await expect(
      exchangeCodeForTokens('code', 'http://localhost/callback')
    ).rejects.toThrow('Network error')
  })
})

describe('getTwitchUser', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('正常系: ユーザー情報が返される', async () => {
    const mockUser = {
      id: '12345',
      login: 'testuser',
      display_name: 'TestUser',
      profile_image_url: 'https://example.com/avatar.png',
      broadcaster_type: 'affiliate',
    }

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [mockUser] }), { status: 200 })
    )

    const { getTwitchUser } = await import('@/lib/twitch/auth')
    const result = await getTwitchUser('test-access-token')

    expect(result).toEqual(mockUser)
  })

  it('異常系: エラーメッセージにステータスコードとレスポンス本文が含まれる', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"message":"Invalid OAuth token"}', { status: 401 })
    )

    const { getTwitchUser } = await import('@/lib/twitch/auth')

    await expect(
      getTwitchUser('invalid-token')
    ).rejects.toThrow(/Failed to get user information: 401/)
  })
})

describe('refreshTwitchToken', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('正常系: 新しいトークンが返される', async () => {
    const mockTokens = {
      access_token: 'new-access-token',
      refresh_token: 'new-refresh-token',
      expires_in: 3600,
      token_type: 'bearer',
      scope: ['user:read:email'],
    }

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockTokens), { status: 200 })
    )

    const { refreshTwitchToken } = await import('@/lib/twitch/auth')
    const result = await refreshTwitchToken('old-refresh-token')

    expect(result).toEqual(mockTokens)
  })

  it('異常系: ステータスだけを保持し、token endpoint本文をErrorへ含めない', async () => {
    const secretSentinel = 'SECRET_SENTINEL_REFRESH_BODY'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(`{"message":"Invalid refresh token ${secretSentinel}"}`, { status: 400 })
    )

    const { refreshTwitchToken } = await import('@/lib/twitch/auth')

    const error = await refreshTwitchToken('expired-refresh-token').catch(value => value as Error)
    if (!(error instanceof Error)) throw new Error('Expected token refresh to reject')
    expect(error.message).toBe('Failed to refresh authentication token: 400')
    expect(error.message).not.toContain(secretSentinel)
    const { logger } = await import('@/lib/logger')
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(secretSentinel)
  })

  it('2xxの不正refresh JSONは本文を捨て、BOTを無効化しない一時失敗へ分類する', async () => {
    const secretSentinel = 'SECRET_MALFORMED_REFRESH_BODY'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(`{"refresh_token":"${secretSentinel}"`, { status: 200 })
    )
    const { refreshTwitchToken, TwitchTokenRefreshError } = await import('@/lib/twitch/auth')

    const error = await refreshTwitchToken('old-refresh-token').catch(value => value as Error)
    if (!(error instanceof Error)) throw new Error('Expected malformed refresh response to reject')

    expect(error).toBeInstanceOf(TwitchTokenRefreshError)
    expect(error.message).toBe('Failed to refresh authentication token: invalid response')
    expect(error.message).not.toContain(secretSentinel)
    expect(error).toMatchObject({ status: 200, retryable: true, kind: 'invalid_response' })
  })

  it('522の一時障害は一度だけ待機して再試行し、成功トークンを返す', async () => {
    vi.useFakeTimers()
    const mockTokens = { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, token_type: 'bearer', scope: [] }
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('error code: 522', { status: 522 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(mockTokens), { status: 200 }))
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { refreshTwitchToken } = await import('@/lib/twitch/auth')

    const result = refreshTwitchToken('old-refresh-token')
    await vi.runAllTimersAsync()

    await expect(result).resolves.toEqual(mockTokens)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('3秒timeoutが2回続いても13秒budget内の3回目で成功する', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((delayMs) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), delayMs)
      return controller.signal
    })
    const waitForAbort = (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Timed out', 'TimeoutError')),
          { once: true },
        )
      })
    const mockTokens = {
      access_token: 'third-attempt-access',
      refresh_token: 'third-attempt-refresh',
      expires_in: 3600,
      token_type: 'bearer',
      scope: [],
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(waitForAbort)
      .mockImplementationOnce(waitForAbort)
      .mockResolvedValueOnce(new Response(JSON.stringify(mockTokens), { status: 200 }))
    const { refreshTwitchToken } = await import('@/lib/twitch/auth')

    const result = refreshTwitchToken('old-refresh-token')
    await vi.runAllTimersAsync()

    await expect(result).resolves.toEqual(mockTokens)
    expect(timeoutSpy).toHaveBeenCalledTimes(3)
    expect(timeoutSpy).toHaveBeenNthCalledWith(1, 3_000)
    expect(timeoutSpy).toHaveBeenNthCalledWith(2, 3_000)
    expect(timeoutSpy).toHaveBeenNthCalledWith(3, 3_000)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('Retry-Afterのdelta-secondsを最低待機時間として尊重する', async () => {
    vi.useFakeTimers()
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('busy', { status: 429, headers: { 'Retry-After': '1' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 1, token_type: 'bearer', scope: [] }), { status: 200 }))
    const { refreshTwitchToken } = await import('@/lib/twitch/auth')

    const result = refreshTwitchToken('old-refresh-token')
    await vi.runAllTimersAsync()

    await expect(result).resolves.toMatchObject({ access_token: 'a' })
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([
    'Fri, 24 Jul 2026 12:00:01 GMT',
    'Friday, 24-Jul-26 12:00:01 GMT',
    'Fri Jul 24 12:00:01 2026',
  ])('Retry-AfterのRFC HTTP-dateを尊重する: %s', async retryAfter => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T12:00:00.000Z'))
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('busy', {
        status: 503,
        headers: { 'Retry-After': retryAfter },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 1, token_type: 'bearer', scope: [] }), { status: 200 }))
    const { refreshTwitchToken } = await import('@/lib/twitch/auth')

    const result = refreshTwitchToken('old-refresh-token')
    await vi.runAllTimersAsync()

    await expect(result).resolves.toMatchObject({ access_token: 'a' })
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('RFC850の2桁年は50年規則で2070年と解釈し、長すぎる待機を早送りしない', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T12:00:00.000Z'))
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('busy', {
        status: 503,
        headers: { 'Retry-After': 'Thursday, 24-Jul-70 12:00:01 GMT' },
      })
    )
    const { refreshTwitchToken } = await import('@/lib/twitch/auth')

    await expect(refreshTwitchToken('old-refresh-token')).rejects.toThrow(/503/)
    // NodeのDate.parseは`-70`を1970年にするが、RFCでは現在から50年以内の2070年。
    // 44年先を0msへ丸めず、このリクエスト内の再送を中止する。
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('RFC850の2桁年がexact 50年先なら過去年へ補正しない', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T12:00:00.000Z'))
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('busy', {
        status: 503,
        headers: { 'Retry-After': 'Friday, 24-Jul-76 12:00:00 GMT' },
      })
    )
    const { refreshTwitchToken } = await import('@/lib/twitch/auth')

    await expect(refreshTwitchToken('old-refresh-token')).rejects.toThrow(/503/)
    // RFCの境界は「50年超」。exact 50年は2076年のままなので、
    // このリクエスト内で待たずに呼び出し元へ失敗を返す。
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('RFC850の2桁年が50年と1秒先なら100年前へ補正する', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T12:00:00.000Z'))
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('busy', {
        status: 503,
        headers: { 'Retry-After': 'Saturday, 24-Jul-76 12:00:01 GMT' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'a', refresh_token: 'r', expires_in: 1, token_type: 'bearer', scope: [],
      }), { status: 200 }))
    const { refreshTwitchToken } = await import('@/lib/twitch/auth')

    const result = refreshTwitchToken('old-refresh-token')
    await vi.runAllTimersAsync()

    await expect(result).resolves.toMatchObject({ access_token: 'a' })
    // 2076年候補は50年と1秒先なので1976年へ戻り、過去日時として即時再試行する。
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('HTTP-dateのleap secondは直前の59秒から1秒後として扱う', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2016-12-31T23:59:59.000Z'))
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('busy', {
        status: 503,
        headers: { 'Retry-After': 'Sat, 31 Dec 2016 23:59:60 GMT' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'a', refresh_token: 'r', expires_in: 1, token_type: 'bearer', scope: [],
      }), { status: 200 }))
    const { refreshTwitchToken } = await import('@/lib/twitch/auth')

    const result = refreshTwitchToken('old-refresh-token')
    await vi.runAllTimersAsync()

    await expect(result).resolves.toMatchObject({ access_token: 'a' })
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1_000)
  })

  it('過去のRetry-After HTTP-dateは待機0msで再試行する', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T12:00:01.000Z'))
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('busy', {
        status: 503,
        headers: { 'Retry-After': 'Fri, 24 Jul 2026 12:00:00 GMT' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 1, token_type: 'bearer', scope: [] }), { status: 200 }))
    const { refreshTwitchToken } = await import('@/lib/twitch/auth')

    const result = refreshTwitchToken('old-refresh-token')
    await vi.runAllTimersAsync()

    await expect(result).resolves.toMatchObject({ access_token: 'a' })
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 0)
  })

  it.each([
    'not-a-date',
    '1.5',
    '+1',
    '-1',
    '2026-07-24',
    '9007199254740992',
    'Tue, 31 Feb 2026 12:00:01 GMT',
    'Thu, 24 Jul 2026 12:00:01 GMT',
  ])('RFC外のRetry-Afterはfull-jitterへフォールバックする: %s', async retryAfter => {
    vi.useFakeTimers()
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('busy', { status: 503, headers: { 'Retry-After': retryAfter } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 1, token_type: 'bearer', scope: [] }), { status: 200 }))
    const { refreshTwitchToken } = await import('@/lib/twitch/auth')

    const result = refreshTwitchToken('old-refresh-token')
    await vi.runAllTimersAsync()

    await expect(result).resolves.toMatchObject({ access_token: 'a' })
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 50)
  })

  it('Retry-Afterがローカル上限を超える場合は早く丸めて再送しない', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('busy', { status: 503, headers: { 'Retry-After': '3' } })
    )
    const { refreshTwitchToken } = await import('@/lib/twitch/auth')

    await expect(refreshTwitchToken('old-refresh-token')).rejects.toThrow(/503/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('400のinvalid refresh tokenは再試行しない', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"message":"Invalid refresh token"}', { status: 400 })
    )
    const { refreshTwitchToken } = await import('@/lib/twitch/auth')

    await expect(refreshTwitchToken('invalid-refresh-token')).rejects.toThrow(/400/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('network failureは上限3回で停止し、元例外本文をErrorへ持ち越さない', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const secretSentinel = 'SECRET_NETWORK_SENTINEL'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(secretSentinel))
    const { refreshTwitchToken } = await import('@/lib/twitch/auth')

    const result = refreshTwitchToken('old-refresh-token')
    // fake timerを進める前にreject handlerを接続し、Nodeのunhandled判定を避ける。
    const captured = result.catch(value => value as Error)
    await vi.runAllTimersAsync()

    const error = await captured
    if (!(error instanceof Error)) throw new Error('Expected network refresh to reject')
    expect(error.message).toBe('Failed to refresh authentication token: network error')
    expect(error.message).not.toContain(secretSentinel)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('retryable statusも上限3回で停止する', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      // Response bodyは単回消費なので、各retryへ新しいResponseを返す。
      new Response('gateway unavailable', { status: 522 })
    )
    const { refreshTwitchToken } = await import('@/lib/twitch/auth')

    const result = refreshTwitchToken('old-refresh-token')
    const rejected = expect(result).rejects.toThrow('Failed to refresh authentication token: 522')
    await vi.runAllTimersAsync()

    await rejected
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
