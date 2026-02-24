import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getSupabaseAdmin } from '@/lib/supabase/admin'

vi.mock('@/lib/supabase/admin')
vi.mock('@/lib/discord/auth')
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

type MockSupabaseAdmin = {
  from: ReturnType<typeof vi.fn>
  select: ReturnType<typeof vi.fn>
  eq: ReturnType<typeof vi.fn>
  maybeSingle?: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
}

describe('Discord Token Manager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('saveDiscordTokens', () => {
    it('正常系: トークンをDBに保存できる', async () => {
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ error: null }),
        select: vi.fn().mockReturnThis(),
      }
      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never)

      const { saveDiscordTokens } = await import('@/lib/discord/token-manager')
      await expect(
        saveDiscordTokens('twitch-user-1', {
          access_token: 'discord-access',
          refresh_token: 'discord-refresh',
          expires_in: 604800,
          token_type: 'Bearer',
          scope: 'identify guilds.members.read',
        }, 'discord-user-1')
      ).resolves.toBeUndefined()

      expect(mockSupabaseAdmin.from).toHaveBeenCalledWith('users')
    })

    it('異常系: UNIQUE制約違反(23505)で ALREADY_LINKED エラーをスローする', async () => {
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({
          error: { code: '23505', message: 'duplicate key value violates unique constraint' },
        }),
        select: vi.fn().mockReturnThis(),
      }
      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never)

      const { saveDiscordTokens } = await import('@/lib/discord/token-manager')
      await expect(
        saveDiscordTokens('twitch-user-1', {
          access_token: 'discord-access',
          refresh_token: 'discord-refresh',
          expires_in: 604800,
          token_type: 'Bearer',
          scope: 'identify guilds.members.read',
        }, 'discord-user-dup')
      ).rejects.toMatchObject({ code: 'ALREADY_LINKED', name: 'DiscordTokenError' })
    })

    it('異常系: PGRST204エラーでは静かにリターンする', async () => {
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({
          error: { code: 'PGRST204', message: 'column not found' },
        }),
        select: vi.fn().mockReturnThis(),
      }
      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never)

      const { saveDiscordTokens } = await import('@/lib/discord/token-manager')
      await expect(
        saveDiscordTokens('twitch-user-1', {
          access_token: 'discord-access',
          refresh_token: 'discord-refresh',
          expires_in: 604800,
          token_type: 'Bearer',
          scope: 'identify guilds.members.read',
        }, 'discord-user-1')
      ).resolves.toBeUndefined()
    })

    it('異常系: その他のDBエラーではraw errorをスローする', async () => {
      const dbError = { code: '42P01', message: 'relation does not exist' }
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ error: dbError }),
        select: vi.fn().mockReturnThis(),
      }
      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never)

      const { saveDiscordTokens } = await import('@/lib/discord/token-manager')
      await expect(
        saveDiscordTokens('twitch-user-1', {
          access_token: 'discord-access',
          refresh_token: 'discord-refresh',
          expires_in: 604800,
          token_type: 'Bearer',
          scope: 'identify guilds.members.read',
        }, 'discord-user-1')
      ).rejects.toEqual(dbError)
    })
  })
})
