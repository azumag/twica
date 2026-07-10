/**
 * #663: auth 系 6 ルートの postgrest 経路 / pg 経路の互換テスト
 *
 * 対象:
 * - POST /api/auth/bot/connect         （読み取りのみ → pg-read で切替）
 * - POST /api/auth/reauth              （ルート自身は読み取りのみ → pg-read で切替）
 * - GET  /api/auth/twitch/login        （読み取りのみ → pg-read で切替）
 * - GET  /api/auth/twitch/callback     （読み書き混在 → pg のみで切替）
 * - POST /api/auth/twitch/check-subscription（読み書き混在 → pg のみで切替）
 * - POST /api/auth/twitch/disable-subscription（書き込みのみ → pg のみで切替）
 *
 * tests/unit/twitch-sub-check-driver-parity.test.ts / announcements-driver-parity.test.ts
 * と同じ流儀: getSupabaseAdmin / getDb / DB_DRIVER をモックし、同一入力に対して
 * 両経路が同一の HTTP 応答・同一の書き込み内容（upsert/update に渡る値）になることを
 * 検証する。エラー系（取得失敗・0 行・スキーマ欠落）も両経路で突き合わせる。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getDb } from '@/lib/db/client'
import { streamers as streamersTable, users as usersTable } from '@/lib/db/schema'
import { getSession } from '@/lib/session'
import { validateCSRFToken } from '@/lib/csrf'
import { deleteTwitchTokens, hasScope, saveTwitchScopes } from '@/lib/twitch/token-manager'
import { getTwitchAuthUrl, exchangeCodeForTokens, getTwitchUser } from '@/lib/twitch/auth'
import { checkTwitchSubViaApi, isTwitchSubCheckEnabled } from '@/lib/twitch/sub-check'
import { handleAuthError } from '@/lib/auth-error-handler'

// ---------------------------------------------------------------------------
// モジュールモック（対象 6 ルートの依存の和集合）
// ---------------------------------------------------------------------------

const mockCookieStore = {
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
}
vi.mock('next/headers', () => ({
  cookies: vi.fn(() => Promise.resolve(mockCookieStore)),
}))

vi.mock('@/lib/session', () => ({
  getSession: vi.fn(),
  canUseStreamerFeatures: vi.fn(() => true),
  parseSession: vi.fn(),
  verifySession: vi.fn(),
  // 署名はテスト対象外なのでペイロードをそのまま返す
  signSession: vi.fn((payload: string) => Promise.resolve(payload)),
}))
vi.mock('@/lib/csrf', () => ({
  validateCSRFToken: vi.fn(),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(() =>
    Promise.resolve({ success: true, limit: 5, remaining: 4, reset: Date.now() + 60_000 })
  ),
  getRateLimitIdentifier: vi.fn(() => Promise.resolve('user:123456789')),
  getClientIp: vi.fn(() => '127.0.0.1'),
  rateLimits: {
    authReauth: {},
    authLogin: {},
    authCallback: {},
    twitchCheckSubscription: {},
    twitchDisableSubscription: {},
  },
}))
vi.mock('@/lib/twitch/auth', () => ({
  getTwitchAuthUrl: vi.fn(
    (_redirectUri: string, _state: string, additionalScopes?: string[]) =>
      `https://id.twitch.tv/oauth2/authorize?scopes=${(additionalScopes ?? []).join(',')}`
  ),
  exchangeCodeForTokens: vi.fn(),
  getTwitchUser: vi.fn(),
  isInvalidAuthorizationCodeError: vi.fn(() => false),
}))
vi.mock('@/lib/twitch/token-manager', () => ({
  deleteTwitchTokens: vi.fn(),
  saveTwitchScopes: vi.fn(),
  hasScope: vi.fn(),
  removeScope: vi.fn(),
}))
vi.mock('@/lib/twitch/sub-check', () => ({
  checkTwitchSubViaApi: vi.fn(),
  isTwitchSubCheckEnabled: vi.fn(() => true),
}))
vi.mock('@/lib/auth-error-handler', () => ({
  handleAuthError: vi.fn((_error: unknown, code: string) => {
    // 実物の代わりに識別可能なオブジェクトを返す（cookies API だけ形を合わせる）
    return Promise.resolve({
      type: 'auth-error',
      code,
      cookies: { set: vi.fn(), delete: vi.fn() },
      headers: { get: vi.fn() },
    })
  }),
}))
vi.mock('@/lib/sentry/error-handler', () => ({
  reportAuthError: vi.fn(),
}))
vi.mock('@/lib/sentry/user-context', () => ({
  setRequestContext: vi.fn(),
  clearUserContext: vi.fn(),
}))
vi.mock('@/lib/crypto-utils', () => ({
  randomBytesHex: vi.fn(() => 'fixed-state'),
}))
vi.mock('@/lib/url-utils', () => ({
  getBaseUrl: vi.fn(() => 'http://localhost:3000'),
}))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// ---------------------------------------------------------------------------
// pg 経路のモック（twitch-sub-check-driver-parity.test.ts の方式 + insert 対応）
// ---------------------------------------------------------------------------

interface PgSelectCall {
  fields: Record<string, unknown>
  table?: unknown
  where?: unknown
  limit?: number
}

interface PgUpdateCall {
  table: unknown
  set?: Record<string, unknown>
  where?: unknown
  returningSelection?: Record<string, unknown>
}

interface PgInsertCall {
  table: unknown
  values?: Record<string, unknown>
  onConflict?: { target: unknown; set: Record<string, unknown> }
  returningSelection?: Record<string, unknown>
}

interface PgResponse {
  rows?: Array<Record<string, unknown>>
  error?: unknown
}

function createDrizzleDbMock(config: {
  selects?: PgResponse[]
  updates?: PgResponse[]
  inserts?: PgResponse[]
} = {}) {
  let selectIndex = 0
  let updateIndex = 0
  let insertIndex = 0
  const selectCalls: PgSelectCall[] = []
  const updateCalls: PgUpdateCall[] = []
  const insertCalls: PgInsertCall[] = []

  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      const responses = config.selects ?? [{ rows: [] }]
      const response = responses[Math.min(selectIndex, responses.length - 1)]
      selectIndex += 1
      const call: PgSelectCall = { fields }
      selectCalls.push(call)
      const resolve = () =>
        response.error
          ? Promise.reject(response.error)
          : Promise.resolve(
              (response.rows ?? []).map((row) =>
                Object.fromEntries(Object.keys(fields).map((key) => [key, row[key] ?? null]))
              )
            )
      const builder: any = {
        from: vi.fn((table: unknown) => {
          call.table = table
          return builder
        }),
        where: vi.fn((condition: unknown) => {
          call.where = condition
          return builder
        }),
        limit: vi.fn((n: number) => {
          call.limit = n
          return builder
        }),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
    update: vi.fn((table: unknown) => {
      const responses = config.updates ?? [{ rows: [{ twitch_user_id: '123456789' }] }]
      const response = responses[Math.min(updateIndex, responses.length - 1)]
      updateIndex += 1
      const call: PgUpdateCall = { table }
      updateCalls.push(call)
      const resolve = () =>
        response.error ? Promise.reject(response.error) : Promise.resolve(response.rows ?? [])
      const builder: any = {
        set: vi.fn((values: Record<string, unknown>) => {
          call.set = values
          return builder
        }),
        where: vi.fn((condition: unknown) => {
          call.where = condition
          return builder
        }),
        returning: vi.fn((selection: Record<string, unknown>) => {
          call.returningSelection = selection
          return resolve()
        }),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
    insert: vi.fn((table: unknown) => {
      const responses = config.inserts ?? [{ rows: [{ twitch_user_id: '123456789' }] }]
      const response = responses[Math.min(insertIndex, responses.length - 1)]
      insertIndex += 1
      const call: PgInsertCall = { table }
      insertCalls.push(call)
      const resolve = () =>
        response.error ? Promise.reject(response.error) : Promise.resolve(response.rows ?? [])
      const builder: any = {
        values: vi.fn((values: Record<string, unknown>) => {
          call.values = values
          return builder
        }),
        onConflictDoUpdate: vi.fn((cfg: { target: unknown; set: Record<string, unknown> }) => {
          call.onConflict = cfg
          return builder
        }),
        returning: vi.fn((selection: Record<string, unknown>) => {
          call.returningSelection = selection
          return resolve()
        }),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
  }
  return { db, selectCalls, updateCalls, insertCalls }
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any)
}

// ---------------------------------------------------------------------------
// 共通 fixture
// ---------------------------------------------------------------------------

const SESSION = {
  twitchUserId: '123456789',
  twitchUsername: 'test-user',
  twitchDisplayName: 'Test User',
  twitchProfileImageUrl: 'https://example.com/avatar.png',
  broadcasterType: 'affiliate',
  expiresAt: Date.now() + 60_000,
  version: 1,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCookieStore.get.mockReturnValue(undefined)
  vi.mocked(getSession).mockResolvedValue(SESSION as any)
  vi.mocked(validateCSRFToken).mockResolvedValue({ valid: true } as any)
  vi.mocked(deleteTwitchTokens).mockResolvedValue()
  vi.mocked(saveTwitchScopes).mockResolvedValue()
  vi.mocked(hasScope).mockResolvedValue(true)
  vi.mocked(isTwitchSubCheckEnabled).mockReturnValue(true)
  vi.mocked(checkTwitchSubViaApi).mockResolvedValue({ hasSub: true, authError: false })
})

afterEach(() => {
  // DB_DRIVER の stub がテスト間・他ファイルへ漏れないよう必ず復元する
  vi.unstubAllEnvs()
})

// ===========================================================================
// POST /api/auth/bot/connect（読み取りのみ → pg-read で切替）
// ===========================================================================

describe('POST /api/auth/bot/connect: postgrest / pg 経路の互換 (#663)', () => {
  function createRequest() {
    return new NextRequest('http://localhost:3000/api/auth/bot/connect', { method: 'POST' })
  }

  function createSupabaseMock(result: { data: unknown; error?: unknown }) {
    const maybeSingle = vi.fn().mockResolvedValue({ data: result.data, error: result.error ?? null })
    const eqFn = vi.fn().mockReturnValue({ maybeSingle })
    const select = vi.fn().mockReturnValue({ eq: eqFn })
    const from = vi.fn().mockReturnValue({ select })
    return { from }
  }

  it('配信者あり: 両経路とも 200 で同一 body を返し、pg 経路は正しい where/limit で streamers を読む', async () => {
    const { POST } = await import('@/app/api/auth/bot/connect/route')

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseMock({ data: { id: 'streamer-1' } })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestRes = await POST(createRequest())
    const postgrestBody = await postgrestRes.json()

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ selects: [{ rows: [{ id: 'streamer-1' }] }] })
    primePgDb(pg)
    const pgRes = await POST(createRequest())
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)
    expect(pgBody).toEqual({ success: true, loginUrl: expect.any(String) })

    expect(pg.selectCalls).toHaveLength(1)
    expect(pg.selectCalls[0].table).toBe(streamersTable)
    expect(pg.selectCalls[0].where).toEqual(eq(streamersTable.twitch_user_id, SESSION.twitchUserId))
    // .maybeSingle() 相当（UNIQUE 制約により最大 1 行）
    expect(pg.selectCalls[0].limit).toBe(1)
  })

  it('配信者なし / DB エラー: 両経路とも 403（既存経路は error を確認せず data=null → 403）', async () => {
    const { POST } = await import('@/app/api/auth/bot/connect/route')

    // postgrest: DB エラーでも data=null → 403
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseMock({ data: null, error: { code: 'PGRST000', message: 'down' } })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestRes = await POST(createRequest())

    // pg: 0 行
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pgNoRow = createDrizzleDbMock({ selects: [{ rows: [] }] })
    primePgDb(pgNoRow)
    const pgNoRowRes = await POST(createRequest())

    // pg: DB エラー（throw）→ catch で null に落として 403
    const pgError = createDrizzleDbMock({ selects: [{ error: { code: '57P01', message: 'shutdown' } }] })
    primePgDb(pgError)
    const pgErrorRes = await POST(createRequest())

    expect(postgrestRes.status).toBe(403)
    expect(pgNoRowRes.status).toBe(403)
    expect(pgErrorRes.status).toBe(403)
    expect(await pgErrorRes.json()).toEqual(await postgrestRes.json())
  })

  it('フラグ未設定時は getDb が一切呼ばれない（挙動不変の検証）', async () => {
    const { POST } = await import('@/app/api/auth/bot/connect/route')
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseMock({ data: { id: 'streamer-1' } })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)

    await POST(createRequest())
    expect(getDb).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// POST /api/auth/reauth（ルート自身は読み取りのみ → pg-read で切替）
// ===========================================================================

describe('POST /api/auth/reauth: postgrest / pg 経路の互換 (#663)', () => {
  function createRequest(additionalScopes: string[] = []) {
    return new Request('http://localhost:3000/api/auth/reauth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ additionalScopes }),
    })
  }

  function createSupabaseMock(result: { data: unknown; error?: unknown }) {
    const maybeSingle = vi.fn().mockResolvedValue({ data: result.data, error: result.error ?? null })
    const eqFn = vi.fn().mockReturnValue({ maybeSingle })
    const select = vi.fn().mockReturnValue({ eq: eqFn })
    const from = vi.fn().mockReturnValue({ select })
    return { from }
  }

  it('既存スコープ保持: 両経路とも同一の getTwitchAuthUrl 引数・同一 body になる', async () => {
    const { POST } = await import('@/app/api/auth/reauth/route')
    const dbScopes = ['user:read:email', 'user:write:chat']

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseMock({ data: { twitch_scopes: dbScopes } })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestRes = await POST(createRequest(['user:read:subscriptions']))
    const postgrestBody = await postgrestRes.json()
    const postgrestAuthArgs = vi.mocked(getTwitchAuthUrl).mock.calls[0]

    vi.clearAllMocks()
    vi.mocked(getSession).mockResolvedValue(SESSION as any)
    vi.mocked(validateCSRFToken).mockResolvedValue({ valid: true } as any)
    vi.mocked(deleteTwitchTokens).mockResolvedValue()

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ selects: [{ rows: [{ twitch_scopes: dbScopes }] }] })
    primePgDb(pg)
    const pgRes = await POST(createRequest(['user:read:subscriptions']))
    const pgBody = await pgRes.json()
    const pgAuthArgs = vi.mocked(getTwitchAuthUrl).mock.calls[0]

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgBody).toEqual(postgrestBody)
    // 追加スコープの合成結果（既存保持 + 要求 + 重複排除）が両経路で一致
    expect(pgAuthArgs).toEqual(postgrestAuthArgs)
    expect(pgAuthArgs[2]).toEqual(['user:write:chat', 'user:read:subscriptions'])
    expect(deleteTwitchTokens).toHaveBeenCalledWith(SESSION.twitchUserId)

    // pg クエリの実引数（twitch_scopes は text[] のため Drizzle スキーマ経由）
    expect(pg.selectCalls[0].table).toBe(usersTable)
    expect(pg.selectCalls[0].fields).toEqual({ twitch_scopes: usersTable.twitch_scopes })
    expect(pg.selectCalls[0].where).toEqual(eq(usersTable.twitch_user_id, SESSION.twitchUserId))
    expect(pg.selectCalls[0].limit).toBe(1)
  })

  it('DB エラー: 両経路とも 503 で同一 body を返し、トークン削除は行わない', async () => {
    const { POST } = await import('@/app/api/auth/reauth/route')

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseMock({ data: null, error: { code: 'PGRST000', message: 'down' } })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestRes = await POST(createRequest())

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ selects: [{ error: { code: '57P01', message: 'shutdown' } }] })
    primePgDb(pg)
    const pgRes = await POST(createRequest())

    expect(postgrestRes.status).toBe(503)
    expect(pgRes.status).toBe(503)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
    expect(deleteTwitchTokens).not.toHaveBeenCalled()
  })

  it('列欠落（PGRST204 / 42703）: 両経路とも継続し、要求スコープのみで再認証 URL を発行する', async () => {
    const { POST } = await import('@/app/api/auth/reauth/route')

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseMock({ data: null, error: { code: 'PGRST204', message: 'no column' } })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestRes = await POST(createRequest(['user:write:chat']))
    const postgrestBody = await postgrestRes.json()
    const postgrestAuthArgs = vi.mocked(getTwitchAuthUrl).mock.calls[0]

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ selects: [{ error: { code: '42703', message: 'column does not exist' } }] })
    primePgDb(pg)
    const pgRes = await POST(createRequest(['user:write:chat']))
    const pgBody = await pgRes.json()
    const pgAuthArgs = vi.mocked(getTwitchAuthUrl).mock.calls[1]

    expect(postgrestRes.status).toBe(200)
    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)
    expect(pgAuthArgs).toEqual(postgrestAuthArgs)
    expect(pgAuthArgs[2]).toEqual(['user:write:chat'])
  })

  it('フラグ未設定時は getDb が一切呼ばれない', async () => {
    const { POST } = await import('@/app/api/auth/reauth/route')
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseMock({ data: { twitch_scopes: [] } })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)

    await POST(createRequest())
    expect(getDb).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// GET /api/auth/twitch/login（読み取りのみ → pg-read で切替）
// ===========================================================================

describe('GET /api/auth/twitch/login: postgrest / pg 経路の互換 (#663)', () => {
  function createRequest() {
    return new Request('http://localhost:3000/api/auth/twitch/login', {
      headers: { 'x-forwarded-for': '127.0.0.1' },
    })
  }

  function createSupabaseMock(result: { data: unknown; error?: unknown }) {
    const maybeSingle = vi.fn().mockResolvedValue({ data: result.data, error: result.error ?? null })
    const eqFn = vi.fn().mockReturnValue({ maybeSingle })
    const select = vi.fn().mockReturnValue({ eq: eqFn })
    const from = vi.fn().mockReturnValue({ select })
    return { from }
  }

  it('スコープ復元: 両経路とも保持スコープ付きの authUrl を返す（body 一致）', async () => {
    const { GET } = await import('@/app/api/auth/twitch/login/route')
    const dbScopes = ['user:read:email', 'user:write:chat']

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseMock({ data: { twitch_scopes: dbScopes } })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestRes = await GET(createRequest())
    const postgrestBody = await postgrestRes.json()
    const postgrestAuthArgs = vi.mocked(getTwitchAuthUrl).mock.calls[0]

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ selects: [{ rows: [{ twitch_scopes: dbScopes }] }] })
    primePgDb(pg)
    const pgRes = await GET(createRequest())
    const pgBody = await pgRes.json()
    const pgAuthArgs = vi.mocked(getTwitchAuthUrl).mock.calls[1]

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgBody).toEqual(postgrestBody)
    // 保持スコープ + forceVerify: false が両経路で一致
    // 注: state(index 1) は crypto.randomUUID() により実行毎に異なるため、
    // 配列全体の deepEqual ではなく state を除く各要素を個別に比較する
    expect(pgAuthArgs[0]).toEqual(postgrestAuthArgs[0])
    expect(typeof pgAuthArgs[1]).toBe('string')
    expect(pgAuthArgs[2]).toEqual(['user:write:chat'])
    expect(pgAuthArgs[3]).toEqual({ forceVerify: false })

    // ガード Cookie はどちらも設定されない
    const guardCalls = mockCookieStore.set.mock.calls.filter(
      (call: unknown[]) => call[0] === 'twica_scope_restore_failed'
    )
    expect(guardCalls).toHaveLength(0)

    expect(pg.selectCalls[0].table).toBe(usersTable)
    expect(pg.selectCalls[0].where).toEqual(eq(usersTable.twitch_user_id, SESSION.twitchUserId))
  })

  it('DB エラー: 両経路ともスコープ復元失敗ガード Cookie を設定して継続する', async () => {
    const { GET } = await import('@/app/api/auth/twitch/login/route')

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseMock({ data: null, error: { code: 'PGRST000', message: 'down' } })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestRes = await GET(createRequest())
    const postgrestGuard = mockCookieStore.set.mock.calls.find(
      (call: unknown[]) => call[0] === 'twica_scope_restore_failed'
    )

    mockCookieStore.set.mockClear()

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ selects: [{ error: { code: '57P01', message: 'shutdown' } }] })
    primePgDb(pg)
    const pgRes = await GET(createRequest())
    const pgGuard = mockCookieStore.set.mock.calls.find(
      (call: unknown[]) => call[0] === 'twica_scope_restore_failed'
    )

    expect(postgrestRes.status).toBe(200)
    expect(pgRes.status).toBe(200)
    expect(postgrestGuard).toBeDefined()
    expect(pgGuard).toBeDefined()
    // 復元失敗時はスコープ無しの authUrl（両経路一致）
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
  })

  it('フラグ未設定時は getDb が一切呼ばれない', async () => {
    const { GET } = await import('@/app/api/auth/twitch/login/route')
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseMock({ data: { twitch_scopes: null } })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)

    await GET(createRequest())
    expect(getDb).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// GET /api/auth/twitch/callback（読み書き混在 → pg のみで切替）
// ===========================================================================

describe('GET /api/auth/twitch/callback: postgrest / pg 経路の互換 (#663)', () => {
  const TOKENS = {
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    expires_in: 3600,
    token_type: 'bearer',
    scope: ['user:read:email', 'openid'],
  }
  const TWITCH_USER = {
    id: '123456789',
    login: 'test-user',
    display_name: 'Test User',
    profile_image_url: 'https://example.com/avatar.png',
    broadcaster_type: 'affiliate',
  }

  function createRequest() {
    return new NextRequest(
      'http://localhost:3000/api/auth/twitch/callback?code=test-code&state=test-state-123'
    )
  }

  function stubAuthCookies() {
    mockCookieStore.get.mockImplementation((name: string) => {
      if (name === 'twitch_auth_state') return { value: 'test-state-123' }
      return undefined
    })
  }

  /**
   * callback の postgrest 経路モック。
   * users: select（1回目 twitch_scopes / 2回目 tos_accepted_at）+ upsert、
   * streamers: upsert。upsert の引数を記録して pg 経路の insert 内容と突き合わせる。
   */
  function createCallbackSupabaseMock(options: {
    existingScopes?: string[] | null
    existingScopeError?: unknown
    usersUpsertError?: unknown
    streamersUpsertError?: unknown
    tosRow?: { tos_accepted_at: string | null } | null
    tosError?: unknown
  }) {
    const upsertCalls: Array<{ table: string; values: Record<string, unknown>; options: unknown }> = []
    const from = vi.fn((table: string) => {
      if (table === 'users') {
        return {
          select: vi.fn((columns: string) => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(() => {
                if (columns === 'twitch_scopes') {
                  if (options.existingScopeError) {
                    return Promise.resolve({ data: null, error: options.existingScopeError })
                  }
                  return Promise.resolve({
                    data:
                      options.existingScopes === undefined || options.existingScopes === null
                        ? null
                        : { twitch_scopes: options.existingScopes },
                    error: null,
                  })
                }
                // tos_accepted_at
                if (options.tosError) {
                  return Promise.resolve({ data: null, error: options.tosError })
                }
                return Promise.resolve({ data: options.tosRow ?? null, error: null })
              }),
            })),
          })),
          upsert: vi.fn((values: Record<string, unknown>, opts: unknown) => {
            upsertCalls.push({ table: 'users', values, options: opts })
            return Promise.resolve({ error: options.usersUpsertError ?? null })
          }),
        }
      }
      return {
        upsert: vi.fn((values: Record<string, unknown>, opts: unknown) => {
          upsertCalls.push({ table: 'streamers', values, options: opts })
          return Promise.resolve({ error: options.streamersUpsertError ?? null })
        }),
      }
    })
    return { from, upsertCalls }
  }

  beforeEach(() => {
    stubAuthCookies()
    vi.mocked(exchangeCodeForTokens).mockResolvedValue(TOKENS as any)
    vi.mocked(getTwitchUser).mockResolvedValue(TWITCH_USER as any)
  })

  it('正常系: 両経路とも /dashboard へリダイレクトし、users/streamers への書き込み内容が一致する', async () => {
    // 両経路が書く twitch_token_expires_at（実行時刻由来）をミリ秒単位まで一致させる
    // ため Date のみ固定する（setTimeout は fake にしない: withDbRetry の遅延を
    // 巻き込まないため。twitch-sub-check-driver-parity.test.ts と同じ方針）
    vi.useFakeTimers({ toFake: ['Date'] })
    const { GET } = await import('@/app/api/auth/twitch/callback/route')

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createCallbackSupabaseMock({
      existingScopes: ['user:read:email'],
      tosRow: { tos_accepted_at: '2024-01-01' },
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestRes = await GET(createRequest())
    const postgrestSaveScopesArgs = vi.mocked(saveTwitchScopes).mock.calls[0]

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [
        { rows: [{ twitch_scopes: ['user:read:email'] }] },
        { rows: [{ tos_accepted_at: '2024-01-01' }] },
      ],
    })
    primePgDb(pg)
    const pgRes = await GET(createRequest())
    const pgSaveScopesArgs = vi.mocked(saveTwitchScopes).mock.calls[1]

    // リダイレクト先・ステータスの一致
    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.headers.get('location')).toBe(postgrestRes.headers.get('location'))
    expect(pgRes.headers.get('location')).toBe('http://localhost:3000/dashboard')

    // users upsert: pg の insert 内容が postgrest の upsert 引数と完全一致
    expect(pg.insertCalls).toHaveLength(2)
    expect(pg.insertCalls[0].table).toBe(usersTable)
    expect(pg.insertCalls[0].values).toEqual(client.upsertCalls[0].values)
    expect(client.upsertCalls[0].options).toEqual({ onConflict: 'twitch_user_id' })
    expect(pg.insertCalls[0].onConflict?.target).toBe(usersTable.twitch_user_id)
    // supabase-js の upsert は payload 全列を DO UPDATE するため set = values
    expect(pg.insertCalls[0].onConflict?.set).toEqual(pg.insertCalls[0].values)

    // streamers upsert（affiliate のため実行される）
    expect(pg.insertCalls[1].table).toBe(streamersTable)
    expect(pg.insertCalls[1].values).toEqual(client.upsertCalls[1].values)
    expect(pg.insertCalls[1].onConflict?.target).toBe(streamersTable.twitch_user_id)
    expect(pg.insertCalls[1].onConflict?.set).toEqual(pg.insertCalls[1].values)

    // スコープの全置換保存が両経路で同一引数
    expect(pgSaveScopesArgs).toEqual(postgrestSaveScopesArgs)
    expect(pgSaveScopesArgs).toEqual([TWITCH_USER.id, TOKENS.scope])

    vi.useRealTimers()
  })

  it('users upsert 失敗: 両経路とも database_error（handleAuthError）になる', async () => {
    const { GET } = await import('@/app/api/auth/twitch/callback/route')

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createCallbackSupabaseMock({
      existingScopes: null,
      usersUpsertError: { code: '23502', message: 'not null violation' },
      tosRow: { tos_accepted_at: '2024-01-01' },
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestRes = (await GET(createRequest())) as any

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [] }],
      inserts: [{ error: { code: '23502', message: 'not null violation' } }],
    })
    primePgDb(pg)
    const pgRes = (await GET(createRequest())) as any

    expect(postgrestRes.code).toBe('database_error')
    expect(pgRes.code).toBe('database_error')
    // database_error は handleAuthError の 'database_error' + operation: 'upsert_user'
    // で両経路とも呼ばれている
    const dbErrorCalls = vi
      .mocked(handleAuthError)
      .mock.calls.filter((call) => call[1] === 'database_error')
    expect(dbErrorCalls).toHaveLength(2)
    expect(dbErrorCalls[0][2]).toEqual(dbErrorCalls[1][2])
  })

  it('streamers upsert 失敗: 両経路ともログインは継続する（postgrest は error 未確認のため）', async () => {
    const { GET } = await import('@/app/api/auth/twitch/callback/route')

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createCallbackSupabaseMock({
      existingScopes: null,
      streamersUpsertError: { code: '23505', message: 'duplicate' },
      tosRow: { tos_accepted_at: '2024-01-01' },
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestRes = await GET(createRequest())

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [] }, { rows: [{ tos_accepted_at: '2024-01-01' }] }],
      // 1 回目（users）は成功・2 回目（streamers）は失敗
      inserts: [{ rows: [] }, { error: { code: '23505', message: 'duplicate' } }],
    })
    primePgDb(pg)
    const pgRes = await GET(createRequest())

    expect(postgrestRes.headers.get('location')).toBe('http://localhost:3000/dashboard')
    expect(pgRes.headers.get('location')).toBe('http://localhost:3000/dashboard')
    expect(pgRes.status).toBe(postgrestRes.status)
  })

  it('TOS 読み取り失敗: 両経路とも TOS ページへは飛ばさずログイン継続（既存経路は error 未確認）', async () => {
    const { GET } = await import('@/app/api/auth/twitch/callback/route')

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createCallbackSupabaseMock({
      existingScopes: null,
      tosError: { code: 'PGRST000', message: 'down' },
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestRes = await GET(createRequest())

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [] }, { error: { code: '57P01', message: 'shutdown' } }],
    })
    primePgDb(pg)
    const pgRes = await GET(createRequest())

    // error → data=null → 「undefined !== null = true」で /dashboard（両経路一致）
    expect(postgrestRes.headers.get('location')).toBe('http://localhost:3000/dashboard')
    expect(pgRes.headers.get('location')).toBe(postgrestRes.headers.get('location'))
  })

  it('TOS 未同意（tos_accepted_at = null）: 両経路とも /tos へリダイレクトする', async () => {
    const { GET } = await import('@/app/api/auth/twitch/callback/route')

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createCallbackSupabaseMock({
      existingScopes: null,
      tosRow: { tos_accepted_at: null },
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestRes = await GET(createRequest())

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [] }, { rows: [{ tos_accepted_at: null }] }],
    })
    primePgDb(pg)
    const pgRes = await GET(createRequest())

    expect(postgrestRes.headers.get('location')).toBe('http://localhost:3000/tos')
    expect(pgRes.headers.get('location')).toBe(postgrestRes.headers.get('location'))
  })

  it('既存スコープ読み取り失敗: 両経路とも fail-safe で saveTwitchScopes をスキップし、ログインは継続する', async () => {
    const { GET } = await import('@/app/api/auth/twitch/callback/route')

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createCallbackSupabaseMock({
      existingScopeError: { code: 'PGRST000', message: 'down' },
      tosRow: { tos_accepted_at: '2024-01-01' },
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestRes = await GET(createRequest())
    const postgrestSaveCount = vi.mocked(saveTwitchScopes).mock.calls.length

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [
        // 57P01 等の一時障害コードは withDbRetry(idempotent:true) が自動リトライしてしまい、
        // createDrizzleDbMock の共有 selectIndex が次エントリ（tos_accepted_at 用）を
        // 誤って消費してしまう。ここでは非リトライ対象の構文エラーコードを使い、
        // 「既存スコープ読み取り失敗時に fail-safe でスキップする」挙動のみを検証する。
        { error: { code: '42601', message: 'syntax error' } },
        { rows: [{ tos_accepted_at: '2024-01-01' }] },
      ],
    })
    primePgDb(pg)
    const pgRes = await GET(createRequest())

    expect(saveTwitchScopes).not.toHaveBeenCalled()
    expect(postgrestSaveCount).toBe(0)
    expect(postgrestRes.headers.get('location')).toBe('http://localhost:3000/dashboard')
    expect(pgRes.headers.get('location')).toBe(postgrestRes.headers.get('location'))
  })

  it('スコープ乖離検出: 両経路とも DB 未変更のまま不足スコープ復元の OAuth へリダイレクトする', async () => {
    const { GET } = await import('@/app/api/auth/twitch/callback/route')
    const dbScopes = ['user:read:email', 'user:write:chat']

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createCallbackSupabaseMock({
      existingScopes: dbScopes,
      tosRow: { tos_accepted_at: '2024-01-01' },
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestRes = await GET(createRequest())

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [{ twitch_scopes: dbScopes }] }],
    })
    primePgDb(pg)
    const pgRes = await GET(createRequest())

    // Twitch OAuth へのリダイレクト URL（不足スコープ入り）が両経路で一致
    expect(postgrestRes.headers.get('location')).toContain('user:write:chat')
    expect(pgRes.headers.get('location')).toBe(postgrestRes.headers.get('location'))
    // DB 未変更（upsert / insert が一切呼ばれない）
    expect(client.upsertCalls).toHaveLength(0)
    expect(pg.insertCalls).toHaveLength(0)
    expect(saveTwitchScopes).not.toHaveBeenCalled()
  })

  it('DB_DRIVER=pg-read では読み書き混在ルートのため postgrest 経路のまま（getDb 不使用）', async () => {
    const { GET } = await import('@/app/api/auth/twitch/callback/route')
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const client = createCallbackSupabaseMock({
      existingScopes: null,
      tosRow: { tos_accepted_at: '2024-01-01' },
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)

    const res = await GET(createRequest())
    expect(res.headers.get('location')).toBe('http://localhost:3000/dashboard')
    expect(getDb).not.toHaveBeenCalled()
    // postgrest 経路の upsert は users / streamers の 2 回実行されている
    expect(client.upsertCalls.map((c) => c.table)).toEqual(['users', 'streamers'])
  })
})

// ===========================================================================
// POST /api/auth/twitch/check-subscription（読み書き混在 → pg のみで切替）
// ===========================================================================

describe('POST /api/auth/twitch/check-subscription: postgrest / pg 経路の互換 (#663)', () => {
  function createRequest() {
    return new Request('http://localhost:3000/api/auth/twitch/check-subscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
  }

  function createSupabaseMock(options: {
    upsertResult: { data: unknown; error: unknown }
    readBackResult?: { data: unknown; error: unknown }
  }) {
    const { upsertResult, readBackResult = upsertResult } = options
    const upsertCalls: Array<{ values: Record<string, unknown>; options: unknown }> = []

    const upsertMaybeSingle = vi.fn().mockResolvedValue(upsertResult)
    const upsertSelect = vi.fn().mockReturnValue({ maybeSingle: upsertMaybeSingle })
    const upsert = vi.fn((values: Record<string, unknown>, opts: unknown) => {
      upsertCalls.push({ values, options: opts })
      return { select: upsertSelect }
    })

    const readBackMaybeSingle = vi.fn().mockResolvedValue(readBackResult)
    const readBackEq = vi.fn().mockReturnValue({ maybeSingle: readBackMaybeSingle })
    const readBackSelect = vi.fn().mockReturnValue({ eq: readBackEq })

    const from = vi.fn().mockReturnValue({ upsert, select: readBackSelect })
    return { from, upsertCalls }
  }

  it('保存成功: 両経路とも同一 body を返し、pg の upsert 内容が postgrest の引数と一致する', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { POST } = await import('@/app/api/auth/twitch/check-subscription/route')

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseMock({
      upsertResult: { data: { twitch_user_id: SESSION.twitchUserId }, error: null },
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestRes = await POST(createRequest())
    const postgrestBody = await postgrestRes.json()

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      inserts: [{ rows: [{ twitch_user_id: SESSION.twitchUserId }] }],
    })
    primePgDb(pg)
    const pgRes = await POST(createRequest())
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)
    expect(pgBody).toEqual({ success: true, hasSub: true, saved: true })

    // upsert 内容の一致（verifiedAt は Date 固定により同一）
    expect(pg.insertCalls).toHaveLength(1)
    expect(pg.insertCalls[0].table).toBe(usersTable)
    expect(pg.insertCalls[0].values).toEqual(client.upsertCalls[0].values)
    expect(client.upsertCalls[0].options).toEqual({ onConflict: 'twitch_user_id' })
    expect(pg.insertCalls[0].onConflict?.target).toBe(usersTable.twitch_user_id)
    expect(pg.insertCalls[0].onConflict?.set).toEqual(pg.insertCalls[0].values)
    // .select('twitch_user_id').maybeSingle() に対応する returning 指定
    expect(pg.insertCalls[0].returningSelection).toEqual({
      twitch_user_id: usersTable.twitch_user_id,
    })

    vi.useRealTimers()
  })

  it('列欠落（PGRST204 / 42703）: 両経路とも 200 + saved=false（saveFailureCode はドライバ由来コード）', async () => {
    const { POST } = await import('@/app/api/auth/twitch/check-subscription/route')

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseMock({
      upsertResult: { data: null, error: { code: 'PGRST204', message: 'column not found' } },
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestRes = await POST(createRequest())
    const postgrestBody = await postgrestRes.json()

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      inserts: [{ error: { code: '42703', message: 'column does not exist' } }],
    })
    primePgDb(pg)
    const pgRes = await POST(createRequest())
    const pgBody = await pgRes.json()

    expect(postgrestRes.status).toBe(200)
    expect(pgRes.status).toBe(200)
    expect(postgrestBody).toEqual({ success: true, hasSub: true, saved: false, saveFailureCode: 'PGRST204' })
    // 既知の表現差: saveFailureCode はドライバ由来のコードをそのまま返す
    // （クライアントは表示用サフィックスとしてしか使わない。route のコメント参照）
    expect(pgBody).toEqual({ success: true, hasSub: true, saved: false, saveFailureCode: '42703' })
  })

  it('保存エラー: 両経路とも 500 で同一 body を返す', async () => {
    const { POST } = await import('@/app/api/auth/twitch/check-subscription/route')

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseMock({
      upsertResult: { data: null, error: { code: 'PGRST000', message: 'db error' } },
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestRes = await POST(createRequest())

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      inserts: [{ error: { code: '57P01', message: 'shutdown' } }],
    })
    primePgDb(pg)
    const pgRes = await POST(createRequest())

    expect(postgrestRes.status).toBe(500)
    expect(pgRes.status).toBe(500)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
  })

  it('返却行が空: 再読込検証で確認できれば saved=true / できなければ NO_ROW_RETURNED（両経路一致）', async () => {
    const { POST } = await import('@/app/api/auth/twitch/check-subscription/route')
    const freshRow = {
      twitch_has_sub: true,
      twitch_sub_verified_at: new Date().toISOString(),
    }

    // --- 確認できるケース ---
    vi.stubEnv('DB_DRIVER', undefined)
    let client = createSupabaseMock({
      upsertResult: { data: null, error: null },
      readBackResult: { data: freshRow, error: null },
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestOk = await (await POST(createRequest())).json()

    vi.stubEnv('DB_DRIVER', 'pg')
    let pg = createDrizzleDbMock({
      inserts: [{ rows: [] }],
      selects: [{ rows: [freshRow] }],
    })
    primePgDb(pg)
    const pgOk = await (await POST(createRequest())).json()

    expect(pgOk).toEqual(postgrestOk)
    expect(pgOk).toEqual({ success: true, hasSub: true, saved: true })

    // --- 確認できないケース（行なし） ---
    vi.stubEnv('DB_DRIVER', undefined)
    client = createSupabaseMock({
      upsertResult: { data: null, error: null },
      readBackResult: { data: null, error: null },
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestNg = await (await POST(createRequest())).json()

    vi.stubEnv('DB_DRIVER', 'pg')
    pg = createDrizzleDbMock({
      inserts: [{ rows: [] }],
      selects: [{ rows: [] }],
    })
    primePgDb(pg)
    const pgNg = await (await POST(createRequest())).json()

    expect(pgNg).toEqual(postgrestNg)
    expect(pgNg).toEqual({ success: true, hasSub: true, saved: false, saveFailureCode: 'NO_ROW_RETURNED' })
  })

  it('DB_DRIVER=pg-read では読み書き混在ルートのため postgrest 経路のまま（getDb 不使用）', async () => {
    const { POST } = await import('@/app/api/auth/twitch/check-subscription/route')
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const client = createSupabaseMock({
      upsertResult: { data: { twitch_user_id: SESSION.twitchUserId }, error: null },
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)

    const res = await POST(createRequest())
    expect(res.status).toBe(200)
    expect(getDb).not.toHaveBeenCalled()
    expect(client.upsertCalls).toHaveLength(1)
  })
})

// ===========================================================================
// POST /api/auth/twitch/disable-subscription（書き込みのみ → pg のみで切替）
// ===========================================================================

describe('POST /api/auth/twitch/disable-subscription: postgrest / pg 経路の互換 (#663)', () => {
  const DISABLED_SUB_VERIFIED_AT = '9999-12-31T00:00:00.000Z'

  function createRequest() {
    return new Request('http://localhost:3000/api/auth/twitch/disable-subscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
  }

  function createSupabaseMock(updateResult: { data: unknown; error: unknown }) {
    const updateCalls: Array<Record<string, unknown>> = []
    const maybeSingle = vi.fn().mockResolvedValue(updateResult)
    const select = vi.fn().mockReturnValue({ maybeSingle })
    const eqFn = vi.fn().mockReturnValue({ select })
    const update = vi.fn((values: Record<string, unknown>) => {
      updateCalls.push(values)
      return { eq: eqFn }
    })
    const from = vi.fn().mockReturnValue({ update })
    return { from, updateCalls }
  }

  it('正常無効化: 両経路とも 200 で同一 body、pg の set/where/returning が既存経路と一致する', async () => {
    const { POST } = await import('@/app/api/auth/twitch/disable-subscription/route')

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseMock({ data: { twitch_user_id: SESSION.twitchUserId }, error: null })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestRes = await POST(createRequest())
    const postgrestBody = await postgrestRes.json()

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      updates: [{ rows: [{ twitch_user_id: SESSION.twitchUserId }] }],
    })
    primePgDb(pg)
    const pgRes = await POST(createRequest())
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)
    expect(pgBody).toEqual({
      success: true,
      hasSub: false,
      twitchSubVerifiedAt: DISABLED_SUB_VERIFIED_AT,
    })

    expect(pg.updateCalls).toHaveLength(1)
    expect(pg.updateCalls[0].table).toBe(usersTable)
    expect(pg.updateCalls[0].set).toEqual(client.updateCalls[0])
    expect(pg.updateCalls[0].set).toEqual({
      twitch_has_sub: false,
      twitch_sub_verified_at: DISABLED_SUB_VERIFIED_AT,
    })
    expect(pg.updateCalls[0].where).toEqual(eq(usersTable.twitch_user_id, SESSION.twitchUserId))
    // 既存の .select('twitch_user_id').maybeSingle()（0 行検出）に対応する returning
    expect(pg.updateCalls[0].returningSelection).toEqual({
      twitch_user_id: usersTable.twitch_user_id,
    })
  })

  it('DB エラー / 0 行更新: 両経路とも 500 で同一 body を返す', async () => {
    const { POST } = await import('@/app/api/auth/twitch/disable-subscription/route')

    // postgrest: DB エラー
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseMock({ data: null, error: { code: 'PGRST000', message: 'db error' } })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestRes = await POST(createRequest())

    // pg: DB エラー（throw）
    vi.stubEnv('DB_DRIVER', 'pg')
    const pgError = createDrizzleDbMock({ updates: [{ error: { code: '57P01', message: 'shutdown' } }] })
    primePgDb(pgError)
    const pgErrorRes = await POST(createRequest())

    // pg: 0 行更新（ユーザー不在）
    const pgZero = createDrizzleDbMock({ updates: [{ rows: [] }] })
    primePgDb(pgZero)
    const pgZeroRes = await POST(createRequest())

    expect(postgrestRes.status).toBe(500)
    expect(pgErrorRes.status).toBe(500)
    expect(pgZeroRes.status).toBe(500)
    expect(await pgErrorRes.json()).toEqual(await postgrestRes.json())
    expect(await pgZeroRes.json()).toEqual({ error: 'Failed to disable subscription status' })
  })

  it('DB_DRIVER=pg-read では書き込みルートのため postgrest 経路のまま（getDb 不使用）', async () => {
    const { POST } = await import('@/app/api/auth/twitch/disable-subscription/route')
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const client = createSupabaseMock({ data: { twitch_user_id: SESSION.twitchUserId }, error: null })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)

    const res = await POST(createRequest())
    expect(res.status).toBe(200)
    expect(getDb).not.toHaveBeenCalled()
    expect(client.updateCalls).toHaveLength(1)
  })
})

// NextResponse を参照している理由: happy-dom 環境で next/server の実物を使うため、
// 型情報を明示的に import してツリーシェイク誤検出を防ぐ（値としては未使用でも
// NextRequest と同一モジュールのため import 自体は必要）。
void NextResponse
