import { describe, it, expect, vi, beforeEach } from 'vitest'

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
    const { AUTH_SCOPES } = await import('@/lib/twitch/auth')
    expect(AUTH_SCOPES).toBe('user:read:email')
  })

  it('AUTH_SCOPES にチャネルポイント系スコープが含まれない', async () => {
    const { AUTH_SCOPES } = await import('@/lib/twitch/auth')
    expect(AUTH_SCOPES).not.toMatch(/channel:read:redemptions/)
    expect(AUTH_SCOPES).not.toMatch(/channel:manage:redemptions/)
  })

  it('ADDITIONAL_SCOPES がチャネルポイント/チャット/サブスクの全step-upスコープを定義', async () => {
    const { ADDITIONAL_SCOPES } = await import('@/lib/twitch/auth')
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
    const { CHANNEL_POINT_SCOPES } = await import('@/lib/twitch/auth')
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
    const { getTwitchAuthUrl, CHANNEL_POINT_SCOPES } = await import('@/lib/twitch/auth')
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

  it('異常系: エラーメッセージにステータスコードとレスポンス本文が含まれる', async () => {
    const errorBody = '{"status":400,"message":"Invalid authorization code"}'

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(errorBody, { status: 400, statusText: 'Bad Request' })
    )

    const { exchangeCodeForTokens } = await import('@/lib/twitch/auth')

    await expect(
      exchangeCodeForTokens('expired-code', 'http://localhost/callback')
    ).rejects.toThrow('Authentication failed: 400 ' + errorBody)

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
    ).rejects.toThrow('Authentication failed: 500 Internal Server Error')
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

  it('異常系: エラーメッセージにステータスコードとレスポンス本文が含まれる', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"message":"Invalid refresh token"}', { status: 400 })
    )

    const { refreshTwitchToken } = await import('@/lib/twitch/auth')

    await expect(
      refreshTwitchToken('expired-refresh-token')
    ).rejects.toThrow(/Failed to refresh authentication token: 400/)
  })
})
