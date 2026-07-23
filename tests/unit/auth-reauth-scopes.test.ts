import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/auth/reauth/route'
import { getSession } from '@/lib/session'
import { deleteTwitchTokens } from '@/lib/twitch/token-manager'
import { validateCSRFToken } from '@/lib/csrf'
import { COOKIE_NAMES } from '@/lib/constants'

vi.mock('@/lib/session')
vi.mock('@/lib/csrf', () => ({
  validateCSRFToken: vi.fn(),
}))
vi.mock('@/lib/twitch/token-manager', () => ({
  deleteTwitchTokens: vi.fn(),
}))
vi.mock('@/lib/twitch/auth', () => ({
  getTwitchAuthUrl: vi.fn(() => 'https://id.twitch.tv/oauth2/authorize?mock=1'),
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
const mockValidateCSRFToken = vi.mocked(validateCSRFToken)

function createRequest(additionalScopes: string[]): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/reauth', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ additionalScopes }),
  })
}

// #788 子C #791: returnTo単体、またはadditionalScopesとの組み合わせを
// リクエストボディで自由に指定するためのヘルパー（上のcreateRequestは
// additionalScopes専用のため、既存テストへの影響を避けて別関数にする）。
function createRequestWithBody(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/reauth', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
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
    mockValidateCSRFToken.mockResolvedValue({ valid: true })

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

  it('チャネルポイント連携有効化の再認証で channel:read/manage:redemptions を要求する', async () => {
    // Issue #398: 初回ログインのAUTH_SCOPESから削除されたチャネルポイント系スコープは、
    // 配信者が連携を有効化する瞬間の step-up 再認証で明示的に要求される。
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue(
      mockUserScopesQuery({
        data: { twitch_scopes: ['user:read:email'] },
        error: null,
      }) as any
    )

    const response = await POST(
      createRequest(['channel:read:redemptions', 'channel:manage:redemptions'])
    )

    expect(response.status).toBe(200)

    const { getTwitchAuthUrl } = await import('@/lib/twitch/auth')
    expect(getTwitchAuthUrl).toHaveBeenCalledWith(
      'https://example.com/api/auth/twitch/callback',
      'fixed-state',
      ['channel:read:redemptions', 'channel:manage:redemptions']
    )
  })

  it('既存チャネルポイント権限は新規スコープ追加時も保持される', async () => {
    // 既存ユーザーがchannel point系スコープをDB上に持っている場合、
    // 別機能のstep-up再認証でも消失しないことを保証する。
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue(
      mockUserScopesQuery({
        data: {
          twitch_scopes: [
            'user:read:email',
            'channel:read:redemptions',
            'channel:manage:redemptions',
          ],
        },
        error: null,
      }) as any
    )

    const response = await POST(createRequest(['user:write:chat']))

    expect(response.status).toBe(200)

    const { getTwitchAuthUrl } = await import('@/lib/twitch/auth')
    const call = vi.mocked(getTwitchAuthUrl).mock.calls[0]
    expect(call[2]).toEqual([
      'channel:read:redemptions',
      'channel:manage:redemptions',
      'user:write:chat',
    ])
  })

  it('CSRFトークンが不正な場合は403を返し、トークン削除も行わない', async () => {
    // Issue #399: 状態変更APIであるreauthは、CSRF検証が失敗した時点で早期リターンする。
    mockValidateCSRFToken.mockResolvedValue({ valid: false, error: 'csrf invalid' })

    const response = await POST(createRequest(['user:read:subscriptions']))

    expect(response.status).toBe(403)

    const { getTwitchAuthUrl } = await import('@/lib/twitch/auth')
    expect(getTwitchAuthUrl).not.toHaveBeenCalled()
    expect(mockDeleteTwitchTokens).not.toHaveBeenCalled()
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

describe('POST /api/auth/reauth returnTo cookie (#788 子C #791)', () => {
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
    mockValidateCSRFToken.mockResolvedValue({ valid: true })

    const { checkRateLimit, getRateLimitIdentifier } = await import('@/lib/rate-limit')
    vi.mocked(checkRateLimit).mockResolvedValue({
      success: true,
      limit: 5,
      remaining: 4,
      reset: Date.now() + 60_000,
    })
    vi.mocked(getRateLimitIdentifier).mockResolvedValue('user:123456789')

    // 既定: 既存の追加スコープなし（このdescribeの関心はreturnToであり、
    // スコープ保持ロジックは上のdescribeで既にカバー済みのため単純化する）
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue(
      mockUserScopesQuery({ data: { twitch_scopes: [] }, error: null }) as any
    )
  })

  it('returnToが/で始まる相対パスの場合、RETURN_TOクッキーにその値を設定する', async () => {
    const response = await POST(createRequestWithBody({ returnTo: '/dashboard/account' }))

    expect(response.status).toBe(200)
    expect(response.cookies.get(COOKIE_NAMES.RETURN_TO)?.value).toBe('/dashboard/account')
  })

  it('returnToが絶対URLの場合、RETURN_TOクッキーは設定されない（オープンリダイレクト対策）', async () => {
    const response = await POST(createRequestWithBody({ returnTo: 'https://evil.example.com/x' }))

    expect(response.status).toBe(200)
    expect(response.cookies.get(COOKIE_NAMES.RETURN_TO)).toBeUndefined()
  })

  it('returnToがプロトコル相対URL(//で開始)の場合、RETURN_TOクッキーは設定されない（オープンリダイレクト対策）', async () => {
    const response = await POST(createRequestWithBody({ returnTo: '//evil.example.com' }))

    expect(response.status).toBe(200)
    expect(response.cookies.get(COOKIE_NAMES.RETURN_TO)).toBeUndefined()
  })

  it('returnToを省略した場合、RETURN_TOクッキーは設定されず、既存の挙動のまま完了する', async () => {
    const response = await POST(createRequest(['user:read:subscriptions']))

    expect(response.status).toBe(200)
    expect(response.cookies.get(COOKIE_NAMES.RETURN_TO)).toBeUndefined()
  })

  it('returnToとadditionalScopesを同時に指定した場合、スコープ処理とcookie設定の両方が行われる', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue(
      mockUserScopesQuery({
        data: { twitch_scopes: ['user:write:chat'] },
        error: null,
      }) as any
    )

    const response = await POST(
      createRequestWithBody({ additionalScopes: ['user:read:subscriptions'], returnTo: '/dashboard/account' })
    )

    expect(response.status).toBe(200)
    expect(response.cookies.get(COOKIE_NAMES.RETURN_TO)?.value).toBe('/dashboard/account')

    const { getTwitchAuthUrl } = await import('@/lib/twitch/auth')
    expect(getTwitchAuthUrl).toHaveBeenCalledWith(
      'https://example.com/api/auth/twitch/callback',
      'fixed-state',
      ['user:write:chat', 'user:read:subscriptions']
    )
    expect(mockDeleteTwitchTokens).toHaveBeenCalledWith('123456789')
  })
})
