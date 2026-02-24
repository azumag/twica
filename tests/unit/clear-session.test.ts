import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mocks ---

const mockCookieStore = {
  get: vi.fn(),
  set: vi.fn(),
}
vi.mock('next/headers', () => ({
  cookies: vi.fn(() => Promise.resolve(mockCookieStore)),
}))

vi.mock('react', () => ({
  cache: (fn: unknown) => fn,
}))

vi.mock('@/lib/constants', () => ({
  BROADCASTER_TYPE: { AFFILIATE: 'affiliate', PARTNER: 'partner', NONE: '' },
  COOKIE_NAMES: {
    SESSION: 'twica_session',
    SCOPE_RESTORE_USER_ID: 'twica_scope_restore_uid',
  },
  getSessionCookieOptions: vi.fn(() => ({ httpOnly: true, maxAge: 2592000, path: '/' })),
  getDeleteCookieOptions: vi.fn(() => ({ httpOnly: true, maxAge: 0, path: '/' })),
}))

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// --- Helpers ---

const makeValidSessionCookie = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    twitchUserId: 'user123',
    twitchUsername: 'testuser',
    twitchDisplayName: 'Test User',
    twitchProfileImageUrl: 'https://example.com/avatar.png',
    broadcasterType: 'affiliate',
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    version: 1,
    ...overrides,
  })

// --- Tests ---

describe('clearSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCookieStore.get.mockReturnValue(undefined)
    mockCookieStore.set.mockReturnValue(undefined)
  })

  it('有効なセッションCookieがある場合: twitchUserIdをSCOPE_RESTORE_USER_IDに保存してセッションを削除する', async () => {
    mockCookieStore.get.mockImplementation((name: string) => {
      if (name === 'twica_session') return { value: makeValidSessionCookie() }
      return undefined
    })

    const { clearSession } = await import('@/lib/session')
    await clearSession()

    // twitchUserIdがスコープ復元用Cookieに保存されること
    expect(mockCookieStore.set).toHaveBeenCalledWith(
      'twica_scope_restore_uid',
      'user123',
      expect.any(Object)
    )
    // セッションCookieがハードログアウト（削除）されること
    expect(mockCookieStore.set).toHaveBeenCalledWith(
      'twica_session',
      '',
      expect.objectContaining({ maxAge: 0 })
    )
  })

  it('expiresAt=0の無効化済みCookieがある場合: twitchUserIdを保存してセッションを削除する', async () => {
    // 旧バージョンのsoft logout等で expiresAt=0 が設定されていた場合
    mockCookieStore.get.mockImplementation((name: string) => {
      if (name === 'twica_session') return { value: makeValidSessionCookie({ expiresAt: 0 }) }
      return undefined
    })

    const { clearSession } = await import('@/lib/session')
    await clearSession()

    expect(mockCookieStore.set).toHaveBeenCalledWith(
      'twica_scope_restore_uid',
      'user123',
      expect.any(Object)
    )
    expect(mockCookieStore.set).toHaveBeenCalledWith(
      'twica_session',
      '',
      expect.objectContaining({ maxAge: 0 })
    )
  })

  it('破損Cookieがある場合: SCOPE_RESTORE_USER_IDを設定せずセッションを削除する', async () => {
    mockCookieStore.get.mockImplementation((name: string) => {
      if (name === 'twica_session') return { value: 'not-valid-json!!!' }
      return undefined
    })

    const { clearSession } = await import('@/lib/session')
    await clearSession()

    // SCOPE_RESTORE_USER_IDは設定されない（フォールバック: スコープ復元なし）
    expect(mockCookieStore.set).not.toHaveBeenCalledWith(
      'twica_scope_restore_uid',
      expect.any(String),
      expect.any(Object)
    )
    // セッションCookieは削除される
    expect(mockCookieStore.set).toHaveBeenCalledWith(
      'twica_session',
      '',
      expect.objectContaining({ maxAge: 0 })
    )
  })

  it('セッションCookieが存在しない場合: セッション削除のみ実行する', async () => {
    mockCookieStore.get.mockReturnValue(undefined)

    const { clearSession } = await import('@/lib/session')
    await clearSession()

    // SCOPE_RESTORE_USER_IDは設定されない
    expect(mockCookieStore.set).not.toHaveBeenCalledWith(
      'twica_scope_restore_uid',
      expect.any(String),
      expect.any(Object)
    )
    // セッションCookieは削除される
    expect(mockCookieStore.set).toHaveBeenCalledWith(
      'twica_session',
      '',
      expect.objectContaining({ maxAge: 0 })
    )
  })
})
