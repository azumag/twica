/**
 * #663 (Batch A): gacha-history 系ルート
 * （GET /api/gacha-history, DELETE /api/gacha-history/[id]）の
 * postgrest 経路 / pg 経路の互換テスト。
 *
 * tests/unit/battle-routes-driver-parity.test.ts / twitch-sub-check-driver-parity.test.ts
 * と同じ流儀（同一 fixture を両経路に与えて HTTP ステータス・レスポンス body・
 * 副作用（DELETE に渡る条件）を突き合わせる）。
 *
 * フラグの使い分け（実装コメント参照）:
 * - GET は streamers.id の単一行取得のみで読み取り専用のため
 *   isPgReadEnabled() で分岐（DB_DRIVER=pg-read でも pg 経路）。
 * - DELETE は所有者チェック(SELECT) + 本体 DELETE の読み書き混在のため関数
 *   全体を isPgWriteEnabled() で分岐（DB_DRIVER=pg のときのみ pg 経路。
 *   pg-read では postgrest 経路のまま = getDb 不使用）。
 *
 * GET ハンドラが呼ぶ getGachaHistoryForStreamer / getGachaHistoryForUser /
 * getGachaUsersForStreamer は #571/#573 で既に二重経路化・パリティテスト済み
 * （dashboard-data-driver-parity.test.ts 等）のため、本テストではモジュール
 * ごと vi.mock してスタブ化し、本バッチで変更した「streamers.id 取得」部分の
 * 分岐と配線のみを検証する（責務の重複を避ける）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { GET } from '@/app/api/gacha-history/route'
import { DELETE } from '@/app/api/gacha-history/[id]/route'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { checkRateLimit } from '@/lib/rate-limit'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { validateCSRFToken } from '@/lib/csrf'
import {
  getGachaHistoryForStreamer,
  getGachaHistoryForUser,
  getGachaUsersForStreamer,
} from '@/lib/dashboard-data'
import { getDb } from '@/lib/db/client'
import { gachaHistory as gachaHistoryTable } from '@/lib/db/schema'

vi.mock('@/lib/session')
vi.mock('@/lib/rate-limit')
vi.mock('@/lib/csrf')
vi.mock('@/lib/dashboard-data')
vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn(),
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}))

const mockGetSession = vi.mocked(getSession)
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures)
const mockCheckRateLimit = vi.mocked(checkRateLimit)
const mockGetSupabaseAdmin = vi.mocked(getSupabaseAdmin)
const mockValidateCSRFToken = vi.mocked(validateCSRFToken)
const mockGetGachaHistoryForStreamer = vi.mocked(getGachaHistoryForStreamer)
const mockGetGachaHistoryForUser = vi.mocked(getGachaHistoryForUser)
const mockGetGachaUsersForStreamer = vi.mocked(getGachaUsersForStreamer)

const STREAMER_SESSION = {
  twitchUserId: 'streamer1',
  twitchUsername: 'streamer1',
  twitchDisplayName: 'Streamer 1',
  twitchProfileImageUrl: '',
  broadcasterType: 'affiliate' as const,
  expiresAt: Date.now() + 100000,
  version: 1,
}

const VIEWER_SESSION = {
  twitchUserId: 'viewer1',
  twitchUsername: 'viewer1',
  twitchDisplayName: 'Viewer 1',
  twitchProfileImageUrl: '',
  broadcasterType: '' as const,
  expiresAt: Date.now() + 100000,
  version: 1,
}

const EMPTY_HISTORY_RESULT = {
  history: [],
  pagination: { page: 1, perPage: 20, total: 0, totalPages: 0 },
}

function allowRateLimit() {
  mockCheckRateLimit.mockResolvedValue({
    success: true,
    limit: 60,
    remaining: 59,
    reset: Date.now() + 60000,
  })
}

// ---------------------------------------------------------------------------
// postgrest 経路のモック（streamers.id 単一行取得のみ）
// ---------------------------------------------------------------------------

function createSupabaseClientMock(streamerRow: { id: string } | null) {
  const from = vi.fn((table: string) => {
    if (table !== 'streamers') {
      throw new Error(`unexpected table in this test: ${table}`)
    }
    const builder: any = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      maybeSingle: vi.fn().mockResolvedValue({ data: streamerRow, error: null }),
    }
    return builder
  })
  return { from }
}

// ---------------------------------------------------------------------------
// pg 経路のモック（twitch-sub-check-driver-parity.test.ts と同方式）
// ---------------------------------------------------------------------------

interface PgSelectCall {
  fields: Record<string, unknown>
  where?: unknown
}
interface PgDeleteCall {
  table: unknown
  where?: unknown
}

function createDrizzleDbMock(config: {
  selects?: Array<{ rows?: Array<Record<string, unknown>>; error?: unknown }>
  deleteError?: unknown
} = {}) {
  let selectIndex = 0
  const selectCalls: PgSelectCall[] = []
  const deleteCalls: PgDeleteCall[] = []

  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      const call: PgSelectCall = { fields }
      selectCalls.push(call)
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
        where: vi.fn((condition: unknown) => {
          call.where = condition
          return builder
        }),
        limit: vi.fn(() => builder),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
    delete: vi.fn((table: unknown) => {
      const call: PgDeleteCall = { table }
      deleteCalls.push(call)
      const resolve = () =>
        config.deleteError ? Promise.reject(config.deleteError) : Promise.resolve()
      const builder: any = {
        where: vi.fn((condition: unknown) => {
          call.where = condition
          return builder
        }),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
  }
  return { db, selectCalls, deleteCalls }
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any)
}

// ---------------------------------------------------------------------------
// GET /api/gacha-history
// ---------------------------------------------------------------------------

describe('GET /api/gacha-history（streamers.id 取得: 読み取り専用のため DB_DRIVER=pg-read でも pg 経路）', () => {
  function createRequest(params: Record<string, string> = {}): NextRequest {
    const url = new URL('http://localhost:3000/api/gacha-history')
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }
    return new NextRequest(url)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    allowRateLimit()
    mockGetGachaHistoryForStreamer.mockResolvedValue(EMPTY_HISTORY_RESULT)
    mockGetGachaHistoryForUser.mockResolvedValue(EMPTY_HISTORY_RESULT)
    mockGetGachaUsersForStreamer.mockResolvedValue({
      users: [],
      pagination: { page: 1, perPage: 20, total: 0, totalPages: 0 },
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('配信者: 両経路とも同じ streamerId で getGachaHistoryForStreamer を呼び、同一レスポンスになる', async () => {
    mockGetSession.mockResolvedValue(STREAMER_SESSION)
    mockCanUseStreamerFeatures.mockReturnValue(true)

    vi.stubEnv('DB_DRIVER', undefined)
    mockGetSupabaseAdmin.mockReturnValue(createSupabaseClientMock({ id: 'streamer-id-1' }) as any)
    const postgrestRes = await GET(createRequest())
    const postgrestBody = await postgrestRes.json()

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ selects: [{ rows: [{ id: 'streamer-id-1' }] }] })
    primePgDb(pg)
    const pgRes = await GET(createRequest())
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)
    expect(mockGetGachaHistoryForStreamer).toHaveBeenCalledWith(
      'streamer-id-1',
      expect.objectContaining({ page: 1, perPage: 20 })
    )
  })

  it('配信者が存在しない（0行）: 両経路とも 404 STREAMER_NOT_FOUND、getGachaHistoryForStreamer は呼ばれない', async () => {
    mockGetSession.mockResolvedValue(STREAMER_SESSION)
    mockCanUseStreamerFeatures.mockReturnValue(true)

    vi.stubEnv('DB_DRIVER', undefined)
    mockGetSupabaseAdmin.mockReturnValue(createSupabaseClientMock(null) as any)
    const postgrestRes = await GET(createRequest())

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ selects: [{ rows: [] }] })
    primePgDb(pg)
    const pgRes = await GET(createRequest())

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(404)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
    expect(mockGetGachaHistoryForStreamer).not.toHaveBeenCalled()
  })

  it('streamers 取得失敗（pg 経路で throw）: 既存実装のエラー握り潰しと同じく 404 扱いになる', async () => {
    mockGetSession.mockResolvedValue(STREAMER_SESSION)
    mockCanUseStreamerFeatures.mockReturnValue(true)
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ selects: [{ error: { code: '08006', message: 'connection failure' } }] })
    primePgDb(pg)

    const res = await GET(createRequest())
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Streamer not found' })
  })

  it('視聴者（streamers 参照なし）: フラグに依らず getGachaHistoryForUser を使い、getDb は呼ばれない', async () => {
    mockGetSession.mockResolvedValue(VIEWER_SESSION)
    mockCanUseStreamerFeatures.mockReturnValue(false)

    for (const driver of [undefined, 'pg-read', 'pg']) {
      vi.stubEnv('DB_DRIVER', driver)
      const res = await GET(createRequest())
      expect(res.status).toBe(200)
    }
    expect(getDb).not.toHaveBeenCalled()
    expect(mockGetGachaHistoryForUser).toHaveBeenCalledWith('viewer1', expect.objectContaining({ page: 1 }))
  })

  it('フラグ未設定時は getDb が一切呼ばれない（挙動不変の検証）', async () => {
    mockGetSession.mockResolvedValue(STREAMER_SESSION)
    mockCanUseStreamerFeatures.mockReturnValue(true)
    vi.stubEnv('DB_DRIVER', undefined)
    mockGetSupabaseAdmin.mockReturnValue(createSupabaseClientMock({ id: 'streamer-id-1' }) as any)

    await GET(createRequest())
    expect(getDb).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/gacha-history/[id]
// ---------------------------------------------------------------------------

describe('DELETE /api/gacha-history/[id]（所有者チェック+DELETEの読み書き混在: DB_DRIVER=pg のときのみ pg 経路）', () => {
  const HISTORY_ID = 'history-1'

  function createRequest(body: Record<string, unknown> = { userId: 'user123' }): NextRequest {
    return new NextRequest(`http://localhost:3000/api/gacha-history/${HISTORY_ID}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  function callDelete(request: NextRequest) {
    return DELETE(request, { params: Promise.resolve({ id: HISTORY_ID }) })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    allowRateLimit()
    mockValidateCSRFToken.mockResolvedValue({ valid: true })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('成功時: 両経路とも 200 + { success: true }、pg 経路の DELETE 条件は eq(id) と一致する', async () => {
    mockGetSession.mockResolvedValue({ ...STREAMER_SESSION, twitchUserId: 'user123' })

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock(null)
    // gacha_history 用に from() を差し替える汎用モック
    const historyClient = {
      from: vi.fn((table: string) => {
        expect(table).toBe('gacha_history')
        const builder: any = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          delete: vi.fn(() => builder),
          maybeSingle: vi.fn().mockResolvedValue({ data: { user_twitch_id: 'user123' }, error: null }),
          then: (onFulfilled: any) => Promise.resolve({ error: null }).then(onFulfilled),
        }
        return builder
      }),
    }
    void client
    mockGetSupabaseAdmin.mockReturnValue(historyClient as any)
    const postgrestRes = await callDelete(createRequest())
    const postgrestBody = await postgrestRes.json()

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({ selects: [{ rows: [{ user_twitch_id: 'user123' }] }] })
    primePgDb(pg)
    const pgRes = await callDelete(createRequest())
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)
    expect(pgBody).toEqual({ success: true })

    expect(pg.deleteCalls).toHaveLength(1)
    expect(pg.deleteCalls[0].table).toBe(gachaHistoryTable)
    expect(pg.deleteCalls[0].where).toEqual(eq(gachaHistoryTable.id, HISTORY_ID))
  })

  it('所有者不一致: 両経路とも 403 FORBIDDEN', async () => {
    mockGetSession.mockResolvedValue({ ...STREAMER_SESSION, twitchUserId: 'user123' })

    vi.stubEnv('DB_DRIVER', undefined)
    const otherOwnerClient = {
      from: vi.fn(() => {
        const builder: any = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          maybeSingle: vi.fn().mockResolvedValue({ data: { user_twitch_id: 'someone-else' }, error: null }),
        }
        return builder
      }),
    }
    mockGetSupabaseAdmin.mockReturnValue(otherOwnerClient as any)
    const postgrestRes = await callDelete(createRequest())

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({ selects: [{ rows: [{ user_twitch_id: 'someone-else' }] }] })
    primePgDb(pg)
    const pgRes = await callDelete(createRequest())

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(403)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
    expect(pg.deleteCalls).toHaveLength(0)
  })

  it('削除対象が存在しない（0行）: 両経路とも 500 "Database error"（no-opではなくエラー、既存の非冪等な仕様）', async () => {
    mockGetSession.mockResolvedValue({ ...STREAMER_SESSION, twitchUserId: 'user123' })

    vi.stubEnv('DB_DRIVER', undefined)
    const notFoundClient = {
      from: vi.fn(() => {
        const builder: any = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        }
        return builder
      }),
    }
    mockGetSupabaseAdmin.mockReturnValue(notFoundClient as any)
    const postgrestRes = await callDelete(createRequest())

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({ selects: [{ rows: [] }] })
    primePgDb(pg)
    const pgRes = await callDelete(createRequest())

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(500)
    const pgBody = await pgRes.json()
    expect(pgBody).toEqual(await postgrestRes.json())
    expect(pgBody).toEqual({ error: 'Database error' })
  })

  it('所有者チェックの取得失敗: 両経路とも 500 "Database error"', async () => {
    mockGetSession.mockResolvedValue({ ...STREAMER_SESSION, twitchUserId: 'user123' })

    vi.stubEnv('DB_DRIVER', undefined)
    const errorClient = {
      from: vi.fn(() => {
        const builder: any = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } }),
        }
        return builder
      }),
    }
    mockGetSupabaseAdmin.mockReturnValue(errorClient as any)
    const postgrestRes = await callDelete(createRequest())

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({ selects: [{ error: { code: '42601', message: 'syntax error' } }] })
    primePgDb(pg)
    const pgRes = await callDelete(createRequest())

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(500)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
  })

  it('DELETE 本体の失敗: 両経路とも 500 "Database error"', async () => {
    mockGetSession.mockResolvedValue({ ...STREAMER_SESSION, twitchUserId: 'user123' })

    vi.stubEnv('DB_DRIVER', undefined)
    const deleteFailClient = {
      from: vi.fn(() => {
        const builder: any = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          delete: vi.fn(() => builder),
          maybeSingle: vi.fn().mockResolvedValue({ data: { user_twitch_id: 'user123' }, error: null }),
          then: (onFulfilled: any) => Promise.resolve({ error: { message: 'boom' } }).then(onFulfilled),
        }
        return builder
      }),
    }
    mockGetSupabaseAdmin.mockReturnValue(deleteFailClient as any)
    const postgrestRes = await callDelete(createRequest())

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [{ user_twitch_id: 'user123' }] }],
      deleteError: { code: '08006', message: 'connection failure' },
    })
    primePgDb(pg)
    const pgRes = await callDelete(createRequest())

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(500)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
  })

  it('DB_DRIVER=pg-read では読み書き混在ハンドラのため postgrest 経路のまま（getDb 不使用）', async () => {
    mockGetSession.mockResolvedValue({ ...STREAMER_SESSION, twitchUserId: 'user123' })
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const client = {
      from: vi.fn(() => {
        const builder: any = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          delete: vi.fn(() => builder),
          maybeSingle: vi.fn().mockResolvedValue({ data: { user_twitch_id: 'user123' }, error: null }),
          then: (onFulfilled: any) => Promise.resolve({ error: null }).then(onFulfilled),
        }
        return builder
      }),
    }
    mockGetSupabaseAdmin.mockReturnValue(client as any)

    const res = await callDelete(createRequest())
    expect(res.status).toBe(200)
    expect(getDb).not.toHaveBeenCalled()
  })

  it('未認証: 両経路とも 401、getDb は呼ばれない', async () => {
    mockGetSession.mockResolvedValue(null)
    for (const driver of [undefined, 'pg']) {
      vi.stubEnv('DB_DRIVER', driver)
      const res = await callDelete(createRequest())
      expect(res.status).toBe(401)
    }
    expect(getDb).not.toHaveBeenCalled()
  })

  it('フラグ未設定時は getDb が一切呼ばれない（挙動不変の検証）', async () => {
    mockGetSession.mockResolvedValue({ ...STREAMER_SESSION, twitchUserId: 'user123' })
    vi.stubEnv('DB_DRIVER', undefined)
    const client = {
      from: vi.fn(() => {
        const builder: any = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          delete: vi.fn(() => builder),
          maybeSingle: vi.fn().mockResolvedValue({ data: { user_twitch_id: 'user123' }, error: null }),
          then: (onFulfilled: any) => Promise.resolve({ error: null }).then(onFulfilled),
        }
        return builder
      }),
    }
    mockGetSupabaseAdmin.mockReturnValue(client as any)

    await callDelete(createRequest())
    expect(getDb).not.toHaveBeenCalled()
  })
})
