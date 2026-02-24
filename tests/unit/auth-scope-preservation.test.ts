import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mocks ---

// next/headers: cookies() mock
const mockCookieStore = {
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
}
vi.mock('next/headers', () => ({
  cookies: vi.fn(() => Promise.resolve(mockCookieStore)),
}))

// next/server: NextResponse and NextRequest
vi.mock('next/server', async () => {
  const actual = await vi.importActual('next/server')
  return {
    ...actual,
    NextResponse: {
      json: vi.fn((body: unknown, init?: ResponseInit) => ({ type: 'json', body, status: init?.status ?? 200, headers: init?.headers })),
      redirect: vi.fn((url: string) => ({
        type: 'redirect',
        url,
        cookies: {
          set: vi.fn(),
          delete: vi.fn(),
        },
        headers: {
          get: vi.fn(() => 'mocked-cookie-header'),
        },
      })),
    },
  }
})

// session module
const mockGetSession = vi.fn()
const mockParseSession = vi.fn()
vi.mock('@/lib/session', () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  parseSession: (...args: unknown[]) => mockParseSession(...args),
}))

// supabase admin - チェーン可能なモック
// getSupabaseAdmin()の呼び出しごとにmockをリセットしないよう、
// 永続的なモックオブジェクトを使用する
const mockMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
const mockEq = vi.fn().mockReturnValue({ maybeSingle: mockMaybeSingle, error: null })
const mockSelect = vi.fn().mockReturnValue({ eq: mockEq })
const mockUpdate = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) })
const mockUpsert = vi.fn().mockResolvedValue({ error: null })
const mockFrom = vi.fn().mockReturnValue({
  select: mockSelect,
  upsert: mockUpsert,
  update: mockUpdate,
})

const mockSupabaseClient = { from: mockFrom }

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: vi.fn(() => mockSupabaseClient),
}))

// twitch auth
vi.mock('@/lib/twitch/auth', () => ({
  getTwitchAuthUrl: vi.fn((_redirectUri: string, _state: string, additionalScopes?: string[]) =>
    `https://twitch.tv/authorize?scopes=${(additionalScopes ?? []).join(',')}`
  ),
  ADDITIONAL_SCOPES: { CHAT_WRITE: 'user:write:chat' },
  exchangeCodeForTokens: vi.fn(),
  getTwitchUser: vi.fn(),
}))

// token-manager
const mockSaveTwitchScopes = vi.fn()
vi.mock('@/lib/twitch/token-manager', () => ({
  saveTwitchScopes: (...args: unknown[]) => mockSaveTwitchScopes(...args),
}))

// rate-limit
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(() => Promise.resolve({ success: true, limit: 5, remaining: 4, reset: Date.now() + 60000 })),
  rateLimits: { authLogin: 'authLogin', authCallback: 'authCallback' },
  getClientIp: vi.fn(() => '127.0.0.1'),
}))

// error handlers and sentry
vi.mock('@/lib/auth-error-handler', () => ({
  handleAuthError: vi.fn((_err: unknown, code: string) => ({ type: 'error', code })),
}))
vi.mock('@/lib/sentry/error-handler', () => ({
  reportAuthError: vi.fn(),
}))
vi.mock('@/lib/sentry/user-context', () => ({
  setRequestContext: vi.fn(),
  clearUserContext: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/url-utils', () => ({
  getBaseUrl: vi.fn(() => 'http://localhost:3000'),
}))
vi.mock('@/lib/env-validation', () => ({
  getEnvVar: vi.fn((name: string) => {
    const vars: Record<string, string> = {
      NEXT_PUBLIC_TWITCH_CLIENT_ID: 'test-client-id',
      TWITCH_CLIENT_SECRET: 'test-client-secret',
    }
    return vars[name] ?? undefined
  }),
}))

// --- Test helpers ---

function createMockRequest(url = 'http://localhost:3000/api/auth/twitch/login'): Request {
  return new Request(url, {
    headers: { 'x-forwarded-for': '127.0.0.1' },
  })
}

// --- Tests ---

describe('Auth scope preservation: login route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCookieStore.get.mockReturnValue(undefined)
    mockCookieStore.set.mockReturnValue(undefined)
    mockGetSession.mockResolvedValue(null)
    mockParseSession.mockImplementation(() => { throw new Error('Invalid session') })
    // Supabaseチェーンを再構築（clearAllMocksでリセットされるため）
    mockEq.mockReturnValue({ maybeSingle: mockMaybeSingle, error: null })
    mockSelect.mockReturnValue({ eq: mockEq })
    mockUpdate.mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) })
    mockUpsert.mockResolvedValue({ error: null })
    mockFrom.mockReturnValue({
      select: mockSelect,
      upsert: mockUpsert,
      update: mockUpdate,
    })
    mockMaybeSingle.mockResolvedValue({ data: null, error: null })
  })

  it('DB障害時にスコープ復元失敗ガードCookieが設定される', async () => {
    // 期限切れセッションCookieが存在し、parseSessionで検証成功する
    const expiredSession = {
      twitchUserId: 'user123',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/avatar.png',
      broadcasterType: 'affiliate',
      expiresAt: Date.now() - 100000, // expired
      version: 1,
    }
    mockCookieStore.get.mockImplementation((name: string) => {
      if (name === 'twica_session') return { value: JSON.stringify(expiredSession) }
      return undefined
    })
    mockParseSession.mockReturnValue(expiredSession)

    // DBクエリがエラーを返す
    mockMaybeSingle.mockResolvedValue({
      data: null,
      error: { code: 'PGRST000', message: 'Connection failed' },
    })

    const { GET } = await import('@/app/api/auth/twitch/login/route')
    await GET(createMockRequest())

    // ガードCookieが設定されていることを確認
    // cookieStore.setは複数回呼ばれる（state + scope_restore_failed）
    const scopeRestoreFailedCall = mockCookieStore.set.mock.calls.find(
      (call: unknown[]) => call[0] === 'twica_scope_restore_failed'
    )
    expect(scopeRestoreFailedCall).toBeDefined()
    // Cookieの値がOAuth stateと一致することを確認
    expect(typeof scopeRestoreFailedCall![1]).toBe('string')
    expect(scopeRestoreFailedCall![1].length).toBeGreaterThan(0)
  })

  it('DB正常時はガードCookieが設定されない', async () => {
    // 有効なセッションがある
    mockGetSession.mockResolvedValue({
      twitchUserId: 'user123',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/avatar.png',
      broadcasterType: 'affiliate',
      expiresAt: Date.now() + 100000,
      version: 1,
    })

    // DBクエリが正常に返す（追加スコープなし）
    mockMaybeSingle.mockResolvedValue({
      data: { twitch_scopes: null },
      error: null,
    })

    const { GET } = await import('@/app/api/auth/twitch/login/route')
    await GET(createMockRequest())

    // ガードCookieが設定されていないことを確認
    const scopeRestoreFailedCall = mockCookieStore.set.mock.calls.find(
      (call: unknown[]) => call[0] === 'twica_scope_restore_failed'
    )
    expect(scopeRestoreFailedCall).toBeUndefined()
  })

  it('parseSession()で検証失敗した改ざんCookieはtwitchUserIdを抽出しない', async () => {
    // 改ざんされたCookie（parseSessionが拒否する）
    mockCookieStore.get.mockImplementation((name: string) => {
      if (name === 'twica_session') return { value: '{"twitchUserId":"attacker123"}' }
      return undefined
    })
    mockParseSession.mockImplementation(() => {
      throw new Error('Invalid session format: missing required fields')
    })

    const { GET } = await import('@/app/api/auth/twitch/login/route')
    await GET(createMockRequest())

    // DBクエリが呼ばれないことを確認（twitchUserIdが取得できなかったため）
    expect(mockFrom).not.toHaveBeenCalledWith('users')
  })

  it('期限切れセッションからparseSession()でtwitchUserIdを正しく抽出する', async () => {
    const expiredSession = {
      twitchUserId: 'user456',
      twitchUsername: 'testuser2',
      twitchDisplayName: 'Test User 2',
      twitchProfileImageUrl: 'https://example.com/avatar2.png',
      broadcasterType: 'partner',
      expiresAt: Date.now() - 100000,
      version: 1,
    }
    mockCookieStore.get.mockImplementation((name: string) => {
      if (name === 'twica_session') return { value: JSON.stringify(expiredSession) }
      return undefined
    })
    mockParseSession.mockReturnValue(expiredSession)

    // DBに追加スコープがある
    mockMaybeSingle.mockResolvedValue({
      data: { twitch_scopes: ['user:read:email', 'user:write:chat'] },
      error: null,
    })

    const { getTwitchAuthUrl } = await import('@/lib/twitch/auth')
    const { GET } = await import('@/app/api/auth/twitch/login/route')
    await GET(createMockRequest())

    // user:write:chatがOAuthリクエストに含まれることを確認
    expect(getTwitchAuthUrl).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      ['user:write:chat'],
      { forceVerify: false },
    )
  })
})

describe('Auth scope preservation: callback route', () => {
  let exchangeCodeForTokens: ReturnType<typeof vi.fn>
  let getTwitchUser: ReturnType<typeof vi.fn>
  const setCallbackMaybeSingleResults = (existingScopes: string[] | null) => {
    mockMaybeSingle.mockReset()
    mockMaybeSingle
      .mockResolvedValueOnce({
        data: { twitch_scopes: existingScopes },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { tos_accepted_at: '2024-01-01' },
        error: null,
      })
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    mockSaveTwitchScopes.mockResolvedValue(undefined)

    const auth = await import('@/lib/twitch/auth')
    exchangeCodeForTokens = vi.mocked(auth.exchangeCodeForTokens)
    getTwitchUser = vi.mocked(auth.getTwitchUser)

    // デフォルトのcookieStore mock
    mockCookieStore.get.mockImplementation((name: string) => {
      if (name === 'twitch_auth_state') return { value: 'test-state-123' }
      return undefined
    })

    // デフォルトのtoken/user mock
    exchangeCodeForTokens.mockResolvedValue({
      access_token: 'test-access-token',
      refresh_token: 'test-refresh-token',
      expires_in: 3600,
      token_type: 'bearer',
      scope: ['user:read:email', 'openid'],
    })
    getTwitchUser.mockResolvedValue({
      id: 'user123',
      login: 'testuser',
      display_name: 'Test User',
      profile_image_url: 'https://example.com/avatar.png',
      broadcaster_type: 'affiliate',
    })

    // Supabaseチェーンを再構築
    mockEq.mockReturnValue({ maybeSingle: mockMaybeSingle, error: null })
    mockSelect.mockReturnValue({ eq: mockEq })
    mockUpdate.mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) })
    mockUpsert.mockResolvedValue({ error: null })
    mockFrom.mockReturnValue({
      select: mockSelect,
      upsert: mockUpsert,
      update: mockUpdate,
    })
    // 1回目: users.twitch_scopes取得, 2回目: users.tos_accepted_at取得
    setCallbackMaybeSingleResults(null)
  })

  it('スコープ復元失敗ガード発動時、saveTwitchScopesがスキップされる', async () => {
    // ガードCookieがstateと一致する
    mockCookieStore.get.mockImplementation((name: string) => {
      if (name === 'twitch_auth_state') return { value: 'test-state-123' }
      if (name === 'twica_scope_restore_failed') return { value: 'test-state-123' }
      return undefined
    })

    const { NextRequest } = await import('next/server')
    const url = 'http://localhost:3000/api/auth/twitch/callback?code=test-code&state=test-state-123'
    const request = new NextRequest(url)

    const { GET } = await import('@/app/api/auth/twitch/callback/route')
    await GET(request)

    // saveTwitchScopesが呼ばれないことを確認
    expect(mockSaveTwitchScopes).not.toHaveBeenCalled()
  })

  it('ガードCookieが存在しない場合、saveTwitchScopesが正常に呼ばれる', async () => {
    // ガードCookieなし
    mockCookieStore.get.mockImplementation((name: string) => {
      if (name === 'twitch_auth_state') return { value: 'test-state-123' }
      return undefined
    })

    const { NextRequest } = await import('next/server')
    const url = 'http://localhost:3000/api/auth/twitch/callback?code=test-code&state=test-state-123'
    const request = new NextRequest(url)

    const { GET } = await import('@/app/api/auth/twitch/callback/route')
    await GET(request)

    // saveTwitchScopesが呼ばれることを確認
    expect(mockSaveTwitchScopes).toHaveBeenCalledWith('user123', ['user:read:email', 'openid'])
  })

  it('通常ログインでは既存の追加スコープをマージして保存する', async () => {
    setCallbackMaybeSingleResults(['user:write:chat'])

    mockCookieStore.get.mockImplementation((name: string) => {
      if (name === 'twitch_auth_state') return { value: 'test-state-123' }
      return undefined
    })

    const { NextRequest } = await import('next/server')
    const url = 'http://localhost:3000/api/auth/twitch/callback?code=test-code&state=test-state-123'
    const request = new NextRequest(url)

    const { GET } = await import('@/app/api/auth/twitch/callback/route')
    await GET(request)

    expect(mockSaveTwitchScopes).toHaveBeenCalledWith('user123', [
      'user:read:email',
      'openid',
      'user:write:chat',
    ])
  })

  it('再認証フローでは既存追加スコープをマージせず全置換する', async () => {
    setCallbackMaybeSingleResults(['user:write:chat'])

    mockCookieStore.get.mockImplementation((name: string) => {
      if (name === 'twitch_auth_state') return { value: 'test-state-123' }
      if (name === 'twica_reauth_state') return { value: 'test-state-123' }
      return undefined
    })

    const { NextRequest } = await import('next/server')
    const url = 'http://localhost:3000/api/auth/twitch/callback?code=test-code&state=test-state-123'
    const request = new NextRequest(url)

    const { GET } = await import('@/app/api/auth/twitch/callback/route')
    await GET(request)

    expect(mockSaveTwitchScopes).toHaveBeenCalledWith('user123', ['user:read:email', 'openid'])
  })

  it('ガードCookieのstateが一致しない場合、saveTwitchScopesが正常に呼ばれる', async () => {
    // ガードCookieのstateが異なる（別のOAuthフローで設定されたもの）
    mockCookieStore.get.mockImplementation((name: string) => {
      if (name === 'twitch_auth_state') return { value: 'test-state-123' }
      if (name === 'twica_scope_restore_failed') return { value: 'different-state-456' }
      return undefined
    })

    const { NextRequest } = await import('next/server')
    const url = 'http://localhost:3000/api/auth/twitch/callback?code=test-code&state=test-state-123'
    const request = new NextRequest(url)

    const { GET } = await import('@/app/api/auth/twitch/callback/route')
    await GET(request)

    // ガードCookieのstateが一致しないため、saveTwitchScopesが正常に実行される
    expect(mockSaveTwitchScopes).toHaveBeenCalledWith('user123', ['user:read:email', 'openid'])
  })

  it('ガードCookieはstate一致時のみ削除される', async () => {
    mockCookieStore.get.mockImplementation((name: string) => {
      if (name === 'twitch_auth_state') return { value: 'test-state-123' }
      if (name === 'twica_scope_restore_failed') return { value: 'test-state-123' }
      return undefined
    })

    const { NextRequest, NextResponse } = await import('next/server')
    const url = 'http://localhost:3000/api/auth/twitch/callback?code=test-code&state=test-state-123'
    const request = new NextRequest(url)

    const { GET } = await import('@/app/api/auth/twitch/callback/route')
    const response = await GET(request) as ReturnType<typeof NextResponse.redirect>

    // ガードCookieが空値で上書き（削除）されることを確認
    expect(response.cookies.set).toHaveBeenCalledWith(
      'twica_scope_restore_failed',
      '',
      expect.any(Object),
    )
  })

  it('ガードCookieのstateが不一致の場合、Cookieは保持される（並行ログイン保護）', async () => {
    // 別タブのloginで設定されたガードCookie（stateが異なる）
    // この場合、別タブのcallbackがガードを利用できるよう削除しない
    // Another tab's guard cookie (different state) should NOT be deleted
    // so the other tab's callback can still use the guard
    mockCookieStore.get.mockImplementation((name: string) => {
      if (name === 'twitch_auth_state') return { value: 'test-state-123' }
      if (name === 'twica_scope_restore_failed') return { value: 'other-tab-state-789' }
      return undefined
    })

    const { NextRequest, NextResponse } = await import('next/server')
    const url = 'http://localhost:3000/api/auth/twitch/callback?code=test-code&state=test-state-123'
    const request = new NextRequest(url)

    const { GET } = await import('@/app/api/auth/twitch/callback/route')
    const response = await GET(request) as ReturnType<typeof NextResponse.redirect>

    // ガードCookieが削除されないことを確認（別タブのガードを保持）
    const deleteCall = (response.cookies.set as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => call[0] === 'twica_scope_restore_failed'
    )
    expect(deleteCall).toBeUndefined()
  })
})
