/**
 * #663/#708: GET /api/auth/twitch/callback のPlanetScale経路テスト
 *
 * このルートはPlanetScaleへ4つの操作を行う:
 *   1. 既存スコープ読み取り（スコープ乖離チェック）
 *   2. users への UPSERT（トークン・プロフィール保存）
 *   3. streamers への UPSERT（アフィリエイト時のみ・結果を確認しない best-effort）
 *   4. users.tos_accepted_at 読み取り（TOS 同意確認）
 *
 * tests/unit/auth-scope-preservation.test.ts のモック構成（next/headers・
 * next/server・session・supabase/admin 等）を踏襲しつつ、pg 経路のアサーション
 * を追加する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { getDb } from '@/lib/db/client'
import { streamers as streamersTable, users as usersTable } from '@/lib/db/schema'

// next/headers: cookies() mock
const mockCookieStore = {
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
}
vi.mock('next/headers', () => ({
  cookies: vi.fn(() => Promise.resolve(mockCookieStore)),
}))

vi.mock('@/lib/session', () => ({
  signSession: (payload: string) => Promise.resolve(payload),
}))

vi.mock('@/lib/twitch/auth', () => ({
  getTwitchAuthUrl: vi.fn(() => 'https://twitch.tv/authorize'),
  exchangeCodeForTokens: vi.fn(),
  getTwitchUser: vi.fn(),
  isInvalidAuthorizationCodeError: vi.fn(() => false),
}))

const mockSaveTwitchScopes = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/twitch/token-manager', () => ({
  saveTwitchScopes: (...args: unknown[]) => mockSaveTwitchScopes(...args),
}))

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(() => Promise.resolve({ success: true, limit: 5, remaining: 4, reset: Date.now() + 60000 })),
  rateLimits: { authCallback: 'authCallback' },
  getClientIp: vi.fn(() => '127.0.0.1'),
}))

const mockHandleAuthError = vi.fn((...args: unknown[]) => {
  const [error, code] = args
  return {
    type: 'error',
    code,
    error,
    cookies: { set: vi.fn(), delete: vi.fn() },
    headers: { get: vi.fn() },
  }
})
vi.mock('@/lib/auth-error-handler', () => ({
  handleAuthError: (...args: unknown[]) => mockHandleAuthError(...args),
}))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/url-utils', () => ({
  getBaseUrl: vi.fn(() => 'http://localhost:3000'),
}))

interface PgResponse {
  rows?: Array<Record<string, unknown>>
  error?: unknown
}

function createDrizzleDbMock(config: { selects?: PgResponse[]; inserts?: PgResponse[] } = {}) {
  let selectIndex = 0
  let insertIndex = 0
  const insertCalls: Array<{ table: unknown; values?: Record<string, unknown>; conflictSet?: Record<string, unknown> }> = []

  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      const responses = config.selects ?? [{ rows: [] }]
      const response = responses[Math.min(selectIndex, responses.length - 1)]
      selectIndex += 1
      const resolve = () =>
        response.error
          ? Promise.reject(response.error)
          : Promise.resolve(
              (response.rows ?? []).map((row) =>
                Object.fromEntries(Object.keys(fields).map((key) => [key, row[key] ?? null]))
              )
            )
      const builder: any = {
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
    insert: vi.fn((table: unknown) => {
      const responses = config.inserts ?? [{ rows: [{}] }]
      const response = responses[Math.min(insertIndex, responses.length - 1)]
      insertIndex += 1
      const call: { table: unknown; values?: Record<string, unknown>; conflictSet?: Record<string, unknown> } = { table }
      insertCalls.push(call)
      const resolve = () => (response.error ? Promise.reject(response.error) : Promise.resolve(response.rows ?? []))
      const builder: any = {
        values: vi.fn((values: Record<string, unknown>) => {
          call.values = values
          return builder
        }),
        onConflictDoUpdate: vi.fn((opts: { set: Record<string, unknown> }) => {
          call.conflictSet = opts.set
          return builder
        }),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
  }
  return { db, insertCalls }
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any)
}

describe('GET /api/auth/twitch/callback: PlanetScale経路 (#663/#708)', () => {
  let exchangeCodeForTokens: ReturnType<typeof vi.fn>
  let getTwitchUser: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.clearAllMocks()
    mockSaveTwitchScopes.mockResolvedValue(undefined)

    const auth = await import('@/lib/twitch/auth')
    exchangeCodeForTokens = vi.mocked(auth.exchangeCodeForTokens)
    getTwitchUser = vi.mocked(auth.getTwitchUser)

    mockCookieStore.get.mockImplementation((name: string) => {
      if (name === 'twitch_auth_state') return { value: 'test-state-123' }
      return undefined
    })

    exchangeCodeForTokens.mockResolvedValue({
      access_token: 'test-access-token',
      refresh_token: 'test-refresh-token',
      expires_in: 3600,
      token_type: 'bearer',
      scope: ['user:read:email'],
    })
    getTwitchUser.mockResolvedValue({
      id: 'user123',
      login: 'testuser',
      display_name: 'Test User',
      profile_image_url: 'https://example.com/avatar.png',
      broadcaster_type: 'affiliate',
    })
  })

  function createCallbackRequest() {
    return new NextRequest('http://localhost:3000/api/auth/twitch/callback?code=test-code&state=test-state-123')
  }

  it('既存スコープ読み取り・users UPSERT・streamers UPSERT・TOS読み取りを実行する', async () => {
    const pg = createDrizzleDbMock({
      selects: [
        { rows: [] }, // 既存スコープなし（乖離チェック通過）
        { rows: [{ tos_accepted_at: '2024-01-01' }] }, // TOS同意済み
      ],
      inserts: [
        { rows: [{}] }, // users upsert
        { rows: [{ id: 'streamer-1' }] }, // streamers upsert（affiliateのため実行される）
      ],
    })
    primePgDb(pg)

    const { GET } = await import('@/app/api/auth/twitch/callback/route')
    const response = await GET(createCallbackRequest())

    expect(getDb).toHaveBeenCalled()
    // リダイレクトが成功していること（database_errorに落ちていない）
    expect(response.status).toBeGreaterThanOrEqual(300)
    expect(response.status).toBeLessThan(400)

    // 1件目の insert は users（トークン・プロフィール保存）
    expect(pg.insertCalls[0].table).toBe(usersTable)
    expect(pg.insertCalls[0].values).toMatchObject({
      twitch_user_id: 'user123',
      twitch_username: 'testuser',
      twitch_access_token: 'test-access-token',
      twitch_refresh_token: 'test-refresh-token',
      twitch_refresh_lease_id: null,
      twitch_refresh_lease_expires_at: null,
    })
    expect(pg.insertCalls[0].conflictSet).toEqual(pg.insertCalls[0].values)

    // 2件目の insert は streamers（affiliateのため実行される）
    expect(pg.insertCalls[1].table).toBe(streamersTable)
    expect(pg.insertCalls[1].values).toMatchObject({
      twitch_user_id: 'user123',
      twitch_username: 'testuser',
      twitch_display_name: 'Test User',
    })
  })

  it('streamers UPSERTが失敗してもコールバック全体は成功する（best-effort）', async () => {
    const pg = createDrizzleDbMock({
      selects: [{ rows: [] }, { rows: [{ tos_accepted_at: '2024-01-01' }] }],
      inserts: [
        { rows: [{}] }, // users upsert 成功
        { error: new Error('constraint violation') }, // streamers upsert 失敗（握りつぶされるはず）
      ],
    })
    primePgDb(pg)

    const { GET } = await import('@/app/api/auth/twitch/callback/route')
    const response = await GET(createCallbackRequest())

    // streamers upsertが失敗しても database_error にならず、正常にリダイレクトされる
    expect(response.status).toBeGreaterThanOrEqual(300)
    expect(response.status).toBeLessThan(400)
    expect(mockHandleAuthError).not.toHaveBeenCalledWith(
      expect.anything(),
      'database_error',
      expect.objectContaining({ operation: 'upsert_streamer' }),
      expect.anything()
    )
  })

  it('users UPSERTが失敗するとdatabase_errorになる', async () => {
    const pg = createDrizzleDbMock({
      selects: [{ rows: [] }],
      inserts: [{ error: new Error('connection lost') }],
    })
    primePgDb(pg)

    const { GET } = await import('@/app/api/auth/twitch/callback/route')
    await GET(createCallbackRequest())

    expect(mockHandleAuthError).toHaveBeenCalledWith(
      expect.anything(),
      'database_error',
      expect.objectContaining({ operation: 'upsert_user' }),
      { baseUrl: 'http://localhost:3000' }
    )
  })

  it('TOS未同意なら/tosへリダイレクトする', async () => {
    const pg = createDrizzleDbMock({
      selects: [{ rows: [] }, { rows: [{ tos_accepted_at: null }] }],
      inserts: [{ rows: [{}] }, { rows: [{ id: 'streamer-1' }] }],
    })
    primePgDb(pg)

    const { GET } = await import('@/app/api/auth/twitch/callback/route')
    const pgResponse = await GET(createCallbackRequest())
    const pgLocation = pgResponse.headers.get('location')

    expect(pgLocation).toContain('/tos')
  })
})
