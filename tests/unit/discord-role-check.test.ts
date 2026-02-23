import { describe, it, expect, vi, beforeEach } from 'vitest'

// Supabaseモックのクエリチェーンビルダー
function createMockQueryBuilder(returnData: unknown = null, returnError: unknown = null) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: returnData, error: returnError }),
  }
}

describe('isDiscordEnabled', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('全環境変数が設定されている場合はtrueを返す', async () => {
    vi.doMock('@/lib/env-validation', () => ({
      getEnvVar: vi.fn((name: string) => {
        const vars: Record<string, string> = {
          DISCORD_CLIENT_ID: 'test-client-id',
          DISCORD_CLIENT_SECRET: 'test-secret',
          DISCORD_GUILD_ID: 'test-guild-id',
          DISCORD_SUB_ROLE_ID: 'test-role-id',
        }
        return vars[name] ?? undefined
      }),
    }))
    vi.doMock('@/lib/supabase/admin', () => ({
      getSupabaseAdmin: vi.fn(() => ({ from: vi.fn(() => createMockQueryBuilder()) })),
    }))
    vi.doMock('@/lib/logger', () => ({
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    }))
    vi.doMock('@/lib/discord/auth', () => ({
      getGuildMember: vi.fn(),
    }))

    const { isDiscordEnabled } = await import('@/lib/discord/role-check')
    expect(isDiscordEnabled()).toBe(true)
  })

  it('環境変数が不足している場合はfalseを返す', async () => {
    vi.doMock('@/lib/env-validation', () => ({
      getEnvVar: vi.fn(() => undefined),
    }))
    vi.doMock('@/lib/supabase/admin', () => ({
      getSupabaseAdmin: vi.fn(() => ({ from: vi.fn(() => createMockQueryBuilder()) })),
    }))
    vi.doMock('@/lib/logger', () => ({
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    }))
    vi.doMock('@/lib/discord/auth', () => ({
      getGuildMember: vi.fn(),
    }))

    const { isDiscordEnabled } = await import('@/lib/discord/role-check')
    expect(isDiscordEnabled()).toBe(false)
  })
})

describe('hasDiscordSubRole', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  function setupDiscordMocks(options: {
    userData?: unknown
    userError?: unknown
  }) {
    const mockQB = createMockQueryBuilder(options.userData ?? null, options.userError ?? null)

    vi.doMock('@/lib/env-validation', () => ({
      getEnvVar: vi.fn((name: string) => {
        const vars: Record<string, string> = {
          DISCORD_CLIENT_ID: 'test-client-id',
          DISCORD_CLIENT_SECRET: 'test-secret',
          DISCORD_GUILD_ID: 'test-guild-id',
          DISCORD_SUB_ROLE_ID: 'test-role-id',
        }
        return vars[name] ?? undefined
      }),
    }))
    vi.doMock('@/lib/supabase/admin', () => ({
      getSupabaseAdmin: vi.fn(() => ({ from: vi.fn(() => mockQB) })),
    }))
    vi.doMock('@/lib/logger', () => ({
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    }))
    vi.doMock('@/lib/discord/auth', () => ({
      getGuildMember: vi.fn(),
    }))

    return mockQB
  }

  it('Discord未連携の場合はfalseを返す', async () => {
    setupDiscordMocks({
      userData: {
        discord_user_id: null,
        discord_access_token: null,
        discord_refresh_token: null,
        discord_token_expires_at: null,
        discord_sub_verified_at: null,
        discord_has_sub_role: false,
      },
    })

    const { hasDiscordSubRole } = await import('@/lib/discord/role-check')
    const result = await hasDiscordSubRole('user-123')
    expect(result).toBe(false)
  })

  it('キャッシュ有効期間内でdiscord_has_sub_role=trueの場合はAPI呼び出しなしでtrueを返す', async () => {
    // 30分前に検証済み → 1時間キャッシュ内、ロールあり
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString()

    setupDiscordMocks({
      userData: {
        discord_user_id: 'discord-123',
        discord_access_token: 'token',
        discord_refresh_token: 'refresh',
        discord_token_expires_at: new Date(Date.now() + 3600000).toISOString(),
        discord_sub_verified_at: thirtyMinutesAgo,
        discord_has_sub_role: true,
      },
    })

    const { hasDiscordSubRole } = await import('@/lib/discord/role-check')
    const result = await hasDiscordSubRole('user-123')
    expect(result).toBe(true)
  })

  it('キャッシュ有効期間内でdiscord_has_sub_role=falseの場合はfalseを返す', async () => {
    // 30分前に検証済み → 1時間キャッシュ内、ロールなし
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString()

    setupDiscordMocks({
      userData: {
        discord_user_id: 'discord-123',
        discord_access_token: 'token',
        discord_refresh_token: 'refresh',
        discord_token_expires_at: new Date(Date.now() + 3600000).toISOString(),
        discord_sub_verified_at: thirtyMinutesAgo,
        discord_has_sub_role: false,
      },
    })

    const { hasDiscordSubRole } = await import('@/lib/discord/role-check')
    const result = await hasDiscordSubRole('user-123')
    expect(result).toBe(false)
  })

  it('DBエラー（PGRST204）の場合はfalseを返す', async () => {
    setupDiscordMocks({
      userError: { code: 'PGRST204', message: 'column not found' },
    })

    const { hasDiscordSubRole } = await import('@/lib/discord/role-check')
    const result = await hasDiscordSubRole('user-123')
    expect(result).toBe(false)
  })

  it('Discord環境変数未設定時はfalseを返す', async () => {
    vi.doMock('@/lib/env-validation', () => ({
      getEnvVar: vi.fn(() => undefined),
    }))
    vi.doMock('@/lib/supabase/admin', () => ({
      getSupabaseAdmin: vi.fn(() => ({ from: vi.fn(() => createMockQueryBuilder()) })),
    }))
    vi.doMock('@/lib/logger', () => ({
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    }))
    vi.doMock('@/lib/discord/auth', () => ({
      getGuildMember: vi.fn(),
    }))

    const { hasDiscordSubRole } = await import('@/lib/discord/role-check')
    const result = await hasDiscordSubRole('user-123')
    expect(result).toBe(false)
  })
})
