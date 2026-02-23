import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

// デフォルトの環境変数モック
vi.mock('@/lib/env-validation', () => ({
  getEnvVar: vi.fn((name: string) => {
    const vars: Record<string, string> = {
      DISCORD_CLIENT_ID: 'test-discord-client-id',
      DISCORD_CLIENT_SECRET: 'test-discord-client-secret',
      DISCORD_GUILD_ID: 'test-guild-id',
      DISCORD_SUB_ROLE_ID: 'test-role-id',
    }
    return vars[name] ?? undefined
  }),
}))

describe('getDiscordAuthUrl', () => {
  it('正常系: 認証URLが正しく生成される', async () => {
    const { getDiscordAuthUrl } = await import('@/lib/discord/auth')
    const url = getDiscordAuthUrl('http://localhost/callback', 'test-state')

    expect(url).toContain('https://discord.com/oauth2/authorize')
    expect(url).toContain('client_id=test-discord-client-id')
    expect(url).toContain('redirect_uri=http%3A%2F%2Flocalhost%2Fcallback')
    expect(url).toContain('response_type=code')
    expect(url).toContain('scope=identify+guilds.members.read')
    expect(url).toContain('state=test-state')
  })

  it('異常系: DISCORD_CLIENT_IDが未設定の場合エラーを投げる', async () => {
    // getEnvVarの戻り値を一時的に変更
    const { getEnvVar } = await import('@/lib/env-validation')
    vi.mocked(getEnvVar).mockReturnValue(undefined)

    const { getDiscordAuthUrl } = await import('@/lib/discord/auth')
    expect(() => getDiscordAuthUrl('http://localhost/callback', 'state')).toThrow(
      'DISCORD_CLIENT_ID is not configured'
    )

    // 元に戻す
    vi.mocked(getEnvVar).mockImplementation((name: string) => {
      const vars: Record<string, string> = {
        DISCORD_CLIENT_ID: 'test-discord-client-id',
        DISCORD_CLIENT_SECRET: 'test-discord-client-secret',
      }
      return vars[name] ?? undefined
    })
  })
})

describe('exchangeDiscordCode', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    // fetch のモックだけ復元、vi.mockで定義したモジュールモックはそのまま
  })

  it('正常系: トークンが正しく返される', async () => {
    const mockTokens = {
      access_token: 'test-access-token',
      refresh_token: 'test-refresh-token',
      expires_in: 604800,
      token_type: 'Bearer',
      scope: 'identify guilds.members.read',
    }

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockTokens), { status: 200 })
    )

    const { exchangeDiscordCode } = await import('@/lib/discord/auth')
    const result = await exchangeDiscordCode('test-code', 'http://localhost/callback')

    expect(result).toEqual(mockTokens)
  })

  it('異常系: エラーメッセージにステータスコードとレスポンス本文が含まれる', async () => {
    const errorBody = '{"error":"invalid_grant"}'

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(errorBody, { status: 400 })
    )

    const { exchangeDiscordCode } = await import('@/lib/discord/auth')

    await expect(
      exchangeDiscordCode('expired-code', 'http://localhost/callback')
    ).rejects.toThrow('Discord authentication failed: 400 ' + errorBody)
  })
})

describe('getDiscordUser', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('正常系: ユーザー情報が返される', async () => {
    const mockUser = {
      id: '123456789',
      username: 'testuser',
      global_name: 'Test User',
      avatar: 'abc123',
    }

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockUser), { status: 200 })
    )

    const { getDiscordUser } = await import('@/lib/discord/auth')
    const result = await getDiscordUser('test-token')

    expect(result).toEqual(mockUser)
  })

  it('異常系: 401エラー時にエラーを投げる', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"message":"401: Unauthorized"}', { status: 401 })
    )

    const { getDiscordUser } = await import('@/lib/discord/auth')

    await expect(getDiscordUser('invalid-token')).rejects.toThrow(
      'Failed to get Discord user information: 401'
    )
  })
})

describe('getGuildMember', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('正常系: ギルドメンバー情報（ロール含む）が返される', async () => {
    const mockMember = {
      roles: ['role-id-1', 'role-id-2', 'test-role-id'],
      nick: 'TestNick',
    }

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockMember), { status: 200 })
    )

    const { getGuildMember } = await import('@/lib/discord/auth')
    const result = await getGuildMember('test-token', 'test-guild-id')

    expect(result.roles).toContain('test-role-id')
    expect(result.nick).toBe('TestNick')
  })

  it('異常系: ギルド未参加（403）の場合エラーを投げる', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"message":"Missing Access"}', { status: 403 })
    )

    const { getGuildMember } = await import('@/lib/discord/auth')

    await expect(getGuildMember('test-token', 'guild-id')).rejects.toThrow(
      'Failed to get guild member information: 403'
    )
  })
})

describe('refreshDiscordToken', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('正常系: リフレッシュ後のトークンが返される', async () => {
    const mockTokens = {
      access_token: 'new-access-token',
      refresh_token: 'new-refresh-token',
      expires_in: 604800,
      token_type: 'Bearer',
      scope: 'identify guilds.members.read',
    }

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockTokens), { status: 200 })
    )

    const { refreshDiscordToken } = await import('@/lib/discord/auth')
    const result = await refreshDiscordToken('old-refresh-token')

    expect(result.access_token).toBe('new-access-token')
  })

  it('異常系: リフレッシュ失敗時にエラーを投げる', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":"invalid_grant"}', { status: 400 })
    )

    const { refreshDiscordToken } = await import('@/lib/discord/auth')

    await expect(refreshDiscordToken('invalid-token')).rejects.toThrow(
      'Failed to refresh Discord authentication token: 400'
    )
  })
})
