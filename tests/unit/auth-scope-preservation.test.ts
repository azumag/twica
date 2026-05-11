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
  // signSession: テストでは署名をスキップし、ペイロードをそのまま返す（crypto不要）
  // signSession: Return payload as-is in tests (no crypto needed)
  signSession: (payload: string) => Promise.resolve(payload),
  verifySession: (payload: string) => Promise.resolve(payload),
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
const mockIsInvalidAuthorizationCodeError = vi.fn(() => false)
vi.mock('@/lib/twitch/auth', () => ({
  getTwitchAuthUrl: vi.fn((_redirectUri: string, _state: string, additionalScopes?: string[]) =>
    `https://twitch.tv/authorize?scopes=${(additionalScopes ?? []).join(',')}`
  ),
  exchangeCodeForTokens: vi.fn(),
  getTwitchUser: vi.fn(),
  isInvalidAuthorizationCodeError: (...args: unknown[]) => mockIsInvalidAuthorizationCodeError(...args),
}))

// token-manager
const mockSaveTwitchScopes = vi.fn()
const mockSaveTwitchTokens = vi.fn()
vi.mock('@/lib/twitch/token-manager', () => ({
  saveTwitchScopes: (...args: unknown[]) => mockSaveTwitchScopes(...args),
  saveTwitchTokens: (...args: unknown[]) => mockSaveTwitchTokens(...args),
}))

// rate-limit
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(() => Promise.resolve({ success: true, limit: 5, remaining: 4, reset: Date.now() + 60000 })),
  rateLimits: { authLogin: 'authLogin', authCallback: 'authCallback' },
  getClientIp: vi.fn(() => '127.0.0.1'),
}))

// error handlers and sentry
const mockHandleAuthError = vi.fn((_err: unknown, code: string) => ({
  type: 'error',
  code,
  cookies: {
    set: vi.fn(),
    delete: vi.fn(),
  },
  headers: {
    get: vi.fn(),
  },
}))
vi.mock('@/lib/auth-error-handler', () => ({
  handleAuthError: (...args: unknown[]) => mockHandleAuthError(...args),
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
    // SCOPE_RESTORE_USER_ID CookieにtwitchUserIdが存在する（ログアウト後のスコープ復元用）
    mockCookieStore.get.mockImplementation((name: string) => {
      if (name === 'twica_scope_restore_uid') return { value: '123456789' }
      return undefined
    })

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
      twitchUserId: '123456789',
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

  it('SCOPE_RESTORE_USER_ID Cookieの値が非数値の場合、不正値としてDBクエリをスキップする', async () => {
    // Twitch user IDは数字のみ。非数値はCookie改ざん/データ破損の可能性があるためスキップ
    // Twitch user IDs are always numeric; non-numeric values indicate tampering or corruption
    mockCookieStore.get.mockImplementation((name: string) => {
      if (name === 'twica_scope_restore_uid') return { value: 'not-a-number' }
      return undefined
    })

    const { GET } = await import('@/app/api/auth/twitch/login/route')
    await GET(createMockRequest())

    // 非数値のためDBクエリが呼ばれないことを確認
    expect(mockFrom).not.toHaveBeenCalledWith('users')
  })

  it('SCOPE_RESTORE_USER_ID Cookieが存在しない場合、twitchUserIdを抽出せずDBクエリを呼ばない', async () => {
    // SCOPE_RESTORE_USER_ID Cookieなし（ログアウト前ログイン、または期限切れ後）
    mockCookieStore.get.mockReturnValue(undefined)

    const { GET } = await import('@/app/api/auth/twitch/login/route')
    await GET(createMockRequest())

    // twitchUserIdが取得できないためDBクエリが呼ばれないことを確認
    expect(mockFrom).not.toHaveBeenCalledWith('users')
  })

  it('明示ログアウト後: SCOPE_RESTORE_USER_ID CookieからtwitchUserIdを取得し追加スコープをOAuthリクエストに含める', async () => {
    // ログアウト時にclearSession()が設定するSCOPE_RESTORE_USER_ID Cookieを模擬
    mockCookieStore.get.mockImplementation((name: string) => {
      if (name === 'twica_scope_restore_uid') return { value: '456789012' }
      return undefined
    })

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

  it('自然失効後（明示ログアウトなし）: 期限切れセッションCookieからtwitchUserIdを取得し追加スコープを復元する', async () => {
    // SCOPE_RESTORE_USER_IDなし（明示ログアウトしていない）
    // 期限切れセッションCookieのみ存在する（7日経過後）
    const expiredSession = {
      twitchUserId: '789012345',
      twitchUsername: 'testuser3',
      twitchDisplayName: 'Test User 3',
      twitchProfileImageUrl: 'https://example.com/avatar3.png',
      broadcasterType: 'affiliate',
      expiresAt: Date.now() - 100000, // expired
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

    // user:write:chatがOAuthリクエストに含まれることを確認（自然失効でもスコープ復元される）
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
  // callbackルートは2回DB参照する:
  // 1. 既存スコープ保護チェック（twitch_scopes取得）
  // 2. TOSチェック（tos_accepted_at取得）
  const setCallbackMaybeSingleResults = (existingScopes: string[] | null = null) => {
    mockMaybeSingle.mockReset()
    // 1回目: 既存スコープ保護チェック
    mockMaybeSingle.mockResolvedValueOnce({
      data: existingScopes !== null ? { twitch_scopes: existingScopes } : null,
      error: null,
    })
    // 2回目: TOSチェック
    mockMaybeSingle.mockResolvedValueOnce({
      data: { tos_accepted_at: '2024-01-01' },
      error: null,
    })
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    mockSaveTwitchScopes.mockResolvedValue(undefined)
    mockSaveTwitchTokens.mockResolvedValue(undefined)

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
    // TOSチェック: users.tos_accepted_at取得
    setCallbackMaybeSingleResults()
  })

  it('無効な認証コード時は非ログ対象エラーで処理し、state Cookieを削除する', async () => {
    const authError = new Error('Authentication failed: 400 {"status":400,"message":"Invalid authorization code"}')
    exchangeCodeForTokens.mockRejectedValueOnce(authError)
    mockIsInvalidAuthorizationCodeError.mockReturnValueOnce(true)

    const errorResponse = {
      type: 'error',
      code: 'invalid_authorization_code',
      cookies: {
        set: vi.fn(),
        delete: vi.fn(),
      },
      headers: {
        get: vi.fn(),
      },
    }
    mockHandleAuthError.mockResolvedValueOnce(errorResponse)

    const { NextRequest } = await import('next/server')
    const url = 'http://localhost:3000/api/auth/twitch/callback?code=test-code&state=test-state-123'
    const request = new NextRequest(url)

    const { GET } = await import('@/app/api/auth/twitch/callback/route')
    const response = await GET(request)

    // Issue #401: OAuth code は短期有効でも秘匿値のため、部分出力もログに残さない
    // The OAuth code must never appear in logs — even a 10-char prefix could
    // assist replay if logs leak. Context is now omitted entirely.
    expect(mockHandleAuthError).toHaveBeenCalledWith(
      authError,
      'invalid_authorization_code',
      undefined,
      { baseUrl: 'http://localhost:3000' },
    )
    expect(errorResponse.cookies.set).toHaveBeenCalledWith(
      'twitch_auth_state',
      '',
      expect.any(Object),
    )
    expect(response).toBe(errorResponse)
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

  it('通常ログインでDBに追加スコープがない場合、トークンのスコープで全置換する', async () => {
    // DBに追加スコープがない → 保護不要 → トークンのスコープで全置換
    mockCookieStore.get.mockImplementation((name: string) => {
      if (name === 'twitch_auth_state') return { value: 'test-state-123' }
      return undefined
    })
    // DBに追加スコープなし（デフォルトスコープのみ）
    setCallbackMaybeSingleResults(['user:read:email'])

    const { NextRequest } = await import('next/server')
    const url = 'http://localhost:3000/api/auth/twitch/callback?code=test-code&state=test-state-123'
    const request = new NextRequest(url)

    const { GET } = await import('@/app/api/auth/twitch/callback/route')
    await GET(request)

    // トークンに含まれるスコープのみで全置換（DBの既存スコープとマージしない）
    expect(mockSaveTwitchScopes).toHaveBeenCalledWith('user123', ['user:read:email', 'openid'])
  })

  it('再認証フローでもトークンのスコープのみ全置換する', async () => {
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

  it('Cookie消失ログイン: DBに追加スコープがあるがトークンにない場合、不足スコープを含むOAuthに自動リダイレクトする', async () => {
    // Cookie無し → loginでスコープ復元されない → トークンにはデフォルトスコープのみ
    // DBにuser:write:chatがある → 不足スコープを含むOAuthフローに自動リダイレクト
    mockCookieStore.get.mockImplementation((name: string) => {
      if (name === 'twitch_auth_state') return { value: 'test-state-123' }
      return undefined
    })
    // DBに追加スコープ（user:write:chat）がある
    setCallbackMaybeSingleResults(['user:read:email', 'user:write:chat'])

    const { NextRequest, NextResponse } = await import('next/server')
    const url = 'http://localhost:3000/api/auth/twitch/callback?code=test-code&state=test-state-123'
    const request = new NextRequest(url)

    const { GET } = await import('@/app/api/auth/twitch/callback/route')
    const response = await GET(request) as ReturnType<typeof NextResponse.redirect>

    // Twitch OAuthにリダイレクトされること（user:write:chatを含む）
    expect(response.type).toBe('redirect')
    expect(response.url).toContain('user:write:chat')

    // SCOPE_RECOVERYとAUTH_STATE cookieが設定されること
    const cookieSetCalls = (response.cookies.set as ReturnType<typeof vi.fn>).mock.calls
    const authStateCookie = cookieSetCalls.find((call: unknown[]) => call[0] === 'twitch_auth_state')
    const scopeRecoveryCookie = cookieSetCalls.find((call: unknown[]) => call[0] === 'twica_scope_recovery')
    expect(authStateCookie).toBeDefined()
    expect(scopeRecoveryCookie).toBeDefined()
    // 両方のcookieが同じstate値を持つこと
    expect(authStateCookie![1]).toBe(scopeRecoveryCookie![1])

    // DB未変更（upsertもsaveScopesも呼ばれない）
    expect(mockUpsert).not.toHaveBeenCalled()
    expect(mockSaveTwitchScopes).not.toHaveBeenCalled()
  })

  it('別端末ログイン: DBに追加スコープがなくトークンにもない場合、通常通り全置換される', async () => {
    // 別端末でもDBに追加スコープがなければ保護不要 → 全置換
    mockCookieStore.get.mockImplementation((name: string) => {
      if (name === 'twitch_auth_state') return { value: 'test-state-123' }
      return undefined
    })
    // DBに追加スコープなし
    setCallbackMaybeSingleResults(['user:read:email'])

    const { NextRequest } = await import('next/server')
    const url = 'http://localhost:3000/api/auth/twitch/callback?code=test-code&state=test-state-123'
    const request = new NextRequest(url)

    const { GET } = await import('@/app/api/auth/twitch/callback/route')
    await GET(request)

    expect(mockSaveTwitchScopes).toHaveBeenCalledWith('user123', ['user:read:email', 'openid'])
  })

  it('部分欠落: DBに2つの追加スコープがあるがトークンに1つだけの場合、全追加スコープを含むOAuthに自動リダイレクトする', async () => {
    // DBにchatとsubの両方がある、トークンにはchatのみ → sub欠落 → リダイレクトで復元
    mockCookieStore.get.mockImplementation((name: string) => {
      if (name === 'twitch_auth_state') return { value: 'test-state-123' }
      return undefined
    })
    // DBにchat + sub両方ある
    setCallbackMaybeSingleResults(['user:read:email', 'user:write:chat', 'user:read:subscriptions'])

    // トークンにはchatのみ含まれている（subは欠落）
    exchangeCodeForTokens.mockResolvedValue({
      access_token: 'test-access-token',
      refresh_token: 'test-refresh-token',
      expires_in: 3600,
      token_type: 'bearer',
      scope: ['user:read:email', 'user:write:chat'],
    })

    const { NextRequest, NextResponse } = await import('next/server')
    const url = 'http://localhost:3000/api/auth/twitch/callback?code=test-code&state=test-state-123'
    const request = new NextRequest(url)

    const { GET } = await import('@/app/api/auth/twitch/callback/route')
    const response = await GET(request) as ReturnType<typeof NextResponse.redirect>

    // 全追加スコープ（chat + sub）を含むOAuthにリダイレクトされること
    expect(response.type).toBe('redirect')
    expect(response.url).toContain('user:write:chat')
    expect(response.url).toContain('user:read:subscriptions')

    // DB未変更
    expect(mockUpsert).not.toHaveBeenCalled()
    expect(mockSaveTwitchScopes).not.toHaveBeenCalled()
  })

  it('DB既存スコープ読み取り失敗時、スコープ保存がスキップされる（fail-safe）', async () => {
    mockCookieStore.get.mockImplementation((name: string) => {
      if (name === 'twitch_auth_state') return { value: 'test-state-123' }
      return undefined
    })
    // DB読み取りエラー
    mockMaybeSingle.mockReset()
    mockMaybeSingle.mockResolvedValueOnce({
      data: null,
      error: { code: 'PGRST000', message: 'Connection failed' },
    })
    // TOSチェック
    mockMaybeSingle.mockResolvedValueOnce({
      data: { tos_accepted_at: '2024-01-01' },
      error: null,
    })

    const { NextRequest } = await import('next/server')
    const url = 'http://localhost:3000/api/auth/twitch/callback?code=test-code&state=test-state-123'
    const request = new NextRequest(url)

    const { GET } = await import('@/app/api/auth/twitch/callback/route')
    await GET(request)

    // fail-safeによりスキップ
    expect(mockSaveTwitchScopes).not.toHaveBeenCalled()
  })

  it('スコープ自動復元2回目callback: SCOPE_RECOVERYがstate一致時、乖離チェックをスキップし通常通りスコープ保存する', async () => {
    // 1回目callbackでSCOPE_RECOVERYを設定してリダイレクトした後の2回目callback
    // 乖離チェックをスキップし、トークンのスコープを全置換で保存する
    mockCookieStore.get.mockImplementation((name: string) => {
      if (name === 'twitch_auth_state') return { value: 'test-state-123' }
      if (name === 'twica_scope_recovery') return { value: 'test-state-123' }
      return undefined
    })
    // DBに追加スコープがある（通常ログインならリダイレクトされるケース）
    setCallbackMaybeSingleResults(['user:read:email', 'user:write:chat'])

    const { NextRequest, NextResponse } = await import('next/server')
    const url = 'http://localhost:3000/api/auth/twitch/callback?code=test-code&state=test-state-123'
    const request = new NextRequest(url)

    const { GET } = await import('@/app/api/auth/twitch/callback/route')
    const response = await GET(request) as ReturnType<typeof NextResponse.redirect>

    // リダイレクトではなく通常のcallback完了（dashboardリダイレクト）
    expect(response.url).toContain('/dashboard')
    // スコープが全置換で保存される
    expect(mockSaveTwitchScopes).toHaveBeenCalledWith('user123', ['user:read:email', 'openid'])
    // SCOPE_RECOVERY cookieが削除される
    const deleteCall = (response.cookies.set as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => call[0] === 'twica_scope_recovery' && call[1] === ''
    )
    expect(deleteCall).toBeDefined()
  })

  it('SCOPE_RECOVERYのstate不一致時は通常の乖離チェックが行われる（並行フロー保護）', async () => {
    // 別タブのSCOPE_RECOVERY cookieが存在するが、stateが異なる
    mockCookieStore.get.mockImplementation((name: string) => {
      if (name === 'twitch_auth_state') return { value: 'test-state-123' }
      if (name === 'twica_scope_recovery') return { value: 'other-tab-state-456' }
      return undefined
    })
    // DBに追加スコープがある → 乖離検出 → リダイレクト
    setCallbackMaybeSingleResults(['user:read:email', 'user:write:chat'])

    const { NextRequest, NextResponse } = await import('next/server')
    const url = 'http://localhost:3000/api/auth/twitch/callback?code=test-code&state=test-state-123'
    const request = new NextRequest(url)

    const { GET } = await import('@/app/api/auth/twitch/callback/route')
    const response = await GET(request) as ReturnType<typeof NextResponse.redirect>

    // state不一致なのでSCOPE_RECOVERYは無視され、乖離チェックが実行 → リダイレクト
    expect(response.type).toBe('redirect')
    expect(response.url).toContain('user:write:chat')
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it('reauthフローでは追加スコープ欠落でもスキップしない（全置換）', async () => {
    // reauthは明示的にスコープ取得するフローなのでスキップしない
    mockCookieStore.get.mockImplementation((name: string) => {
      if (name === 'twitch_auth_state') return { value: 'test-state-123' }
      if (name === 'twica_reauth_state') return { value: 'test-state-123' }
      return undefined
    })
    // DBに追加スコープがある（通常ログインならスキップされるケース）
    setCallbackMaybeSingleResults(['user:read:email', 'user:write:chat'])

    const { NextRequest } = await import('next/server')
    const url = 'http://localhost:3000/api/auth/twitch/callback?code=test-code&state=test-state-123'
    const request = new NextRequest(url)

    const { GET } = await import('@/app/api/auth/twitch/callback/route')
    await GET(request)

    // reauthフローなのでスキップせず全置換
    expect(mockSaveTwitchScopes).toHaveBeenCalledWith('user123', ['user:read:email', 'openid'])
  })

  it('認証成功時にSCOPE_RESTORE_USER_ID Cookieが削除される', async () => {
    // 認証完了後はセッションCookieにtwitchUserIdが含まれるため
    // スコープ復元用Cookie（twica_scope_restore_uid）は不要になる
    // After successful auth, twitchUserId is in session cookie, so scope-restore cookie is cleaned up
    const { NextRequest, NextResponse } = await import('next/server')
    const url = 'http://localhost:3000/api/auth/twitch/callback?code=test-code&state=test-state-123'
    const request = new NextRequest(url)

    const { GET } = await import('@/app/api/auth/twitch/callback/route')
    const response = await GET(request) as ReturnType<typeof NextResponse.redirect>

    // SCOPE_RESTORE_USER_ID Cookieが空値で上書き（削除）されることを確認
    expect(response.cookies.set).toHaveBeenCalledWith(
      'twica_scope_restore_uid',
      '',
      expect.any(Object),
    )
  })
})
