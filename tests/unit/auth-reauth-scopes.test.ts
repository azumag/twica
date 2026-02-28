import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/auth/reauth/route'
import { getSession } from '@/lib/session'
import { deleteTwitchTokens } from '@/lib/twitch/token-manager'

vi.mock('@/lib/session')
vi.mock('@/lib/twitch/token-manager', () => ({
  deleteTwitchTokens: vi.fn(),
}))
vi.mock('@/lib/twitch/auth', () => ({
  getTwitchAuthUrl: vi.fn(() => 'https://id.twitch.tv/oauth2/authorize?mock=1'),
  ADDITIONAL_SCOPES: {
    CHAT_WRITE: 'user:write:chat',
    USER_READ_SUBSCRIPTIONS: 'user:read:subscriptions',
  },
}))
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    success: true,
    limit: 5,
    remaining: 4,
    reset: Date.now() + 60000,
  }),
  rateLimits: { authReauth: {} },
  getRateLimitIdentifier: vi.fn().mockResolvedValue('user:123456789'),
}))
vi.mock('@/lib/crypto-utils', () => ({
  randomBytesHex: vi.fn(() => 'fixed-state'),
}))
vi.mock('@/lib/url-utils', () => ({
  getBaseUrl: vi.fn(() => 'https://example.com'),
}))
vi.mock('@/lib/supabase/admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/admin')>()
  return {
    ...actual,
    getSupabaseAdmin: vi.fn(),
  }
})

const mockGetSession = vi.mocked(getSession)
const mockDeleteTwitchTokens = vi.mocked(deleteTwitchTokens)

function createRequest(additionalScopes: string[]): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/reauth', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ additionalScopes }),
  })
}

function mockUserScopesQuery(result: { data: unknown; error: { code?: string; message?: string } | null }) {
  const maybeSingle = vi.fn().mockResolvedValue(result)
  const eq = vi.fn().mockReturnValue({ maybeSingle })
  const select = vi.fn().mockReturnValue({ eq })
  const from = vi.fn().mockReturnValue({ select })

  return { from }
}

describe('POST /api/auth/reauth scope merge', () => {
  beforeEach(async () => {
    vi.clearAllMocks()

    mockGetSession.mockResolvedValue({
      twitchUserId: '123456789',
      twitchUsername: 'test-user',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/avatar.png',
      broadcasterType: 'affiliate',
      expiresAt: Date.now() + 60_000,
      version: 1,
    })
    mockDeleteTwitchTokens.mockResolvedValue()

    const { checkRateLimit, getRateLimitIdentifier } = await import('@/lib/rate-limit')
    vi.mocked(checkRateLimit).mockResolvedValue({
      success: true,
      limit: 5,
      remaining: 4,
      reset: Date.now() + 60_000,
    })
    vi.mocked(getRateLimitIdentifier).mockResolvedValue('user:123456789')
  })

  it('既存の user:write:chat を保持したまま user:read:subscriptions を追加要求する', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue(
      mockUserScopesQuery({
        data: { twitch_scopes: ['user:read:email', 'user:write:chat'] },
        error: null,
      }) as any
    )

    const response = await POST(createRequest(['user:read:subscriptions']))

    expect(response.status).toBe(200)

    const { getTwitchAuthUrl } = await import('@/lib/twitch/auth')
    expect(getTwitchAuthUrl).toHaveBeenCalledWith(
      'https://example.com/api/auth/twitch/callback',
      'fixed-state',
      ['user:write:chat', 'user:read:subscriptions']
    )
    expect(mockDeleteTwitchTokens).toHaveBeenCalledWith('123456789')
  })

  it('既存・要求に重複があっても追加スコープは重複しない', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue(
      mockUserScopesQuery({
        data: { twitch_scopes: ['user:write:chat', 'user:read:subscriptions'] },
        error: null,
      }) as any
    )

    const response = await POST(createRequest(['user:read:subscriptions']))

    expect(response.status).toBe(200)

    const { getTwitchAuthUrl } = await import('@/lib/twitch/auth')
    const call = vi.mocked(getTwitchAuthUrl).mock.calls[0]
    expect(call[2]).toEqual(['user:write:chat', 'user:read:subscriptions'])
  })

  it('チャット権限を追加する再認証でも既存のサブスク権限を保持する', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue(
      mockUserScopesQuery({
        data: { twitch_scopes: ['user:read:subscriptions'] },
        error: null,
      }) as any
    )

    const response = await POST(createRequest(['user:write:chat']))

    expect(response.status).toBe(200)

    const { getTwitchAuthUrl } = await import('@/lib/twitch/auth')
    expect(getTwitchAuthUrl).toHaveBeenCalledWith(
      'https://example.com/api/auth/twitch/callback',
      'fixed-state',
      ['user:read:subscriptions', 'user:write:chat']
    )
  })

  it('スコープ取得のDBエラー時は再認証を中止し、トークン削除を行わない', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue(
      mockUserScopesQuery({
        data: null,
        error: { code: 'PGRST000', message: 'db unavailable' },
      }) as any
    )

    const response = await POST(createRequest(['user:read:subscriptions']))

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: 'Failed to prepare re-authorization. Please try again.',
    })

    const { getTwitchAuthUrl } = await import('@/lib/twitch/auth')
    expect(getTwitchAuthUrl).not.toHaveBeenCalled()
    expect(mockDeleteTwitchTokens).not.toHaveBeenCalled()
  })
})
