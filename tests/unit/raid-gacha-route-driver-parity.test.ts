/**
 * #663 Batch C: GET/POST /api/streamer/raid-gacha の postgrest 経路 / pg 経路の
 * 互換テスト。
 *
 * tests/unit/cards-id-route-driver-parity.test.ts と同じ流儀（from(table) ごとに
 * 応答キューを消費する thenable builder）。
 *
 * フラグ使い分け:
 * - GET は読み取り専用のため isPgReadEnabled() で分岐（DB_DRIVER=pg-read でも pg 経路）。
 * - POST は streamers.raid_gacha_draw_count への UPDATE(書き込み)を含むため、
 *   所有権確認(streamers select)も含めてリクエスト全体を isPgWriteEnabled() で
 *   分岐する（DB_DRIVER=pg のときのみ pg 経路。pg-read では postgrest のまま）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET, POST } from '@/app/api/streamer/raid-gacha/route'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { checkRateLimit } from '@/lib/rate-limit'
import { validateCSRFToken } from '@/lib/csrf'
import { validateContentType } from '@/lib/request-validation'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getDb } from '@/lib/db/client'
import { streamers as streamersTable } from '@/lib/db/schema'

vi.mock('@/lib/session')
vi.mock('@/lib/rate-limit')
vi.mock('@/lib/csrf')
vi.mock('@/lib/request-validation')
vi.mock('@/lib/sentry/error-handler', () => ({
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}))

const mockGetSession = vi.mocked(getSession)
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures)
const mockCheckRateLimit = vi.mocked(checkRateLimit)
const mockValidateCSRFToken = vi.mocked(validateCSRFToken)
const mockValidateContentType = vi.mocked(validateContentType)
const mockGetSupabaseAdmin = vi.mocked(getSupabaseAdmin)

const SESSION = {
  twitchUserId: 'user1',
  twitchUsername: 'streamer',
  twitchDisplayName: 'Streamer',
  twitchProfileImageUrl: '',
  broadcasterType: 'affiliate' as const,
  expiresAt: Date.now() + 60_000,
  version: 1,
}

function allowRateLimit() {
  mockCheckRateLimit.mockResolvedValue({
    success: true,
    limit: 100,
    remaining: 99,
    reset: Date.now() + 60000,
  })
}

// ---------------------------------------------------------------------------
// postgrest 経路のモック: from("streamers") の応答キューを消費する thenable builder
// (cards-id-route-driver-parity.test.ts と同方式)
// ---------------------------------------------------------------------------

interface PostgrestResponse {
  data?: unknown
  error?: unknown
}

function createSupabaseClientMock(responses: PostgrestResponse[]) {
  const queue = [...responses]
  const updateCalls: Array<{ values: unknown }> = []
  const from = vi.fn(() => {
    const response = queue.length > 1 ? queue.shift()! : queue[0]
    const resolved = { data: response.data ?? null, error: response.error ?? null }
    const builder: any = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      update: vi.fn((values: unknown) => {
        updateCalls.push({ values: { ...(values as object) } })
        return builder
      }),
      maybeSingle: vi.fn(() => Promise.resolve(resolved)),
      then: (onFulfilled: any, onRejected: any) => Promise.resolve(resolved).then(onFulfilled, onRejected),
    }
    return builder
  })
  return { from, updateCalls }
}

// ---------------------------------------------------------------------------
// pg 経路のモック(cards-id-route-driver-parity.test.ts と同方式)
// ---------------------------------------------------------------------------

function createDrizzleDbMock(config: {
  selects?: Array<{ rows?: Array<Record<string, unknown>>; error?: unknown }>
  updates?: Array<{ rows?: Array<Record<string, unknown>>; error?: unknown }>
} = {}) {
  let selectIndex = 0
  let updateIndex = 0
  const updateCalls: Array<{ table: unknown; set?: unknown; where?: unknown }> = []

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
    update: vi.fn((table: unknown) => {
      const call: { table: unknown; set?: unknown; where?: unknown } = { table }
      updateCalls.push(call)
      const responses = config.updates ?? [{ rows: [] }]
      const response = responses[Math.min(updateIndex, responses.length - 1)]
      updateIndex += 1
      const builder: any = {
        set: vi.fn((values: unknown) => {
          call.set = { ...(values as object) }
          return builder
        }),
        where: vi.fn((condition: unknown) => {
          call.where = condition
          return builder
        }),
        returning: vi.fn(() =>
          response.error ? Promise.reject(response.error) : Promise.resolve(response.rows ?? [])
        ),
      }
      return builder
    }),
  }
  return { db, updateCalls }
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any)
}

beforeEach(() => {
  vi.clearAllMocks()
  allowRateLimit()
  mockGetSession.mockResolvedValue(SESSION)
  mockCanUseStreamerFeatures.mockReturnValue(true)
  mockValidateCSRFToken.mockResolvedValue({ valid: true })
  mockValidateContentType.mockReturnValue(null)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// ---------------------------------------------------------------------------
// GET /api/streamer/raid-gacha
// ---------------------------------------------------------------------------

describe('GET /api/streamer/raid-gacha（読み取り専用: DB_DRIVER=pg-read でも pg 経路）', () => {
  const FUTURE_ISO = new Date(Date.now() + 60_000).toISOString()
  const ACTIVE_STREAMER_ROW = { id: 'streamer1', raid_gacha_active_until: FUTURE_ISO, raid_gacha_draw_count: 5 }

  function run(driver: string | undefined) {
    vi.stubEnv('DB_DRIVER', driver)
    return GET(new NextRequest('http://localhost/api/streamer/raid-gacha'))
  }

  it('成功時(有効なレイドガチャ状態): 両経路のレスポンスが一致する', async () => {
    const client = createSupabaseClientMock([{ data: ACTIVE_STREAMER_ROW }])
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await run(undefined)
    const postgrestBody = await postgrestRes.json()

    const pg = createDrizzleDbMock({ selects: [{ rows: [ACTIVE_STREAMER_ROW] }] })
    primePgDb(pg)
    const pgRes = await run('pg-read')
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)
    expect(pgBody).toEqual({ active: true, activeUntil: FUTURE_ISO, drawCount: 5 })
  })

  it('streamer が見つからない: 両経路とも 404 + 同一 body', async () => {
    const client = createSupabaseClientMock([{ data: null }])
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await run(undefined)

    const pg = createDrizzleDbMock({ selects: [{ rows: [] }] })
    primePgDb(pg)
    const pgRes = await run('pg-read')

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(404)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
  })

  it('raid_gacha_* 列がデプロイ窓で未検出: 両経路とも active:false, drawCount:0 にフォールバックする', async () => {
    const MISSING_RAID_STATE_ERROR_POSTGREST = { code: 'PGRST204', message: "Could not find the 'raid_gacha_active_until' column" }
    const MISSING_RAID_STATE_ERROR_PG = { code: '42703', message: 'column "raid_gacha_active_until" of relation "streamers" does not exist' }
    const BARE_STREAMER_ROW = { id: 'streamer1' }

    const client = createSupabaseClientMock([{ error: MISSING_RAID_STATE_ERROR_POSTGREST }, { data: BARE_STREAMER_ROW }])
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await run(undefined)
    const postgrestBody = await postgrestRes.json()

    const pg = createDrizzleDbMock({
      selects: [{ error: MISSING_RAID_STATE_ERROR_PG }, { rows: [BARE_STREAMER_ROW] }],
    })
    primePgDb(pg)
    const pgRes = await run('pg-read')
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)
    expect(pgBody).toEqual({ active: false, activeUntil: null, drawCount: 0 })
  })

  it('取得失敗(未知のエラー): 両経路とも 500 + 同一 body', async () => {
    const DB_ERROR = { message: 'boom' }
    const client = createSupabaseClientMock([{ error: DB_ERROR }])
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await run(undefined)

    const pg = createDrizzleDbMock({ selects: [{ error: { code: '42601', message: 'syntax error' } }] })
    primePgDb(pg)
    const pgRes = await run('pg-read')

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(500)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
  })

  it('フラグ未設定時は getDb が一切呼ばれない(挙動不変の検証)', async () => {
    const client = createSupabaseClientMock([{ data: ACTIVE_STREAMER_ROW }])
    mockGetSupabaseAdmin.mockReturnValue(client as any)

    await run(undefined)
    expect(getDb).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// POST /api/streamer/raid-gacha
// ---------------------------------------------------------------------------

describe('POST /api/streamer/raid-gacha（読み書き混在: DB_DRIVER=pg のときのみ pg 経路）', () => {
  const STREAMER_ROW = { id: 'streamer1', raid_gacha_active_until: null, raid_gacha_draw_count: 0 }
  const UPDATED_ROW = { raid_gacha_active_until: null, raid_gacha_draw_count: 7 }

  function createPostRequest(body: Record<string, unknown> = { drawCount: 7 }): NextRequest {
    return new NextRequest('http://localhost/api/streamer/raid-gacha', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('成功時: 両経路のレスポンス body と streamers への UPDATE 値が一致する', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock([{ data: STREAMER_ROW }, { data: UPDATED_ROW }])
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await POST(createPostRequest())
    const postgrestBody = await postgrestRes.json()

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [STREAMER_ROW] }],
      updates: [{ rows: [UPDATED_ROW] }],
    })
    primePgDb(pg)
    const pgRes = await POST(createPostRequest())
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)
    expect(pgBody).toEqual({ success: true, active: false, activeUntil: null, drawCount: 7 })

    expect(pg.updateCalls).toHaveLength(1)
    expect(pg.updateCalls[0].table).toBe(streamersTable)
    expect(pg.updateCalls[0].set).toEqual(client.updateCalls[0].values)
    expect(pg.updateCalls[0].set).toEqual({ raid_gacha_draw_count: 7 })
  })

  it('drawCount が範囲外: 両経路とも 400 + 同一 body(UPDATE は実行されない)', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock([{ data: STREAMER_ROW }])
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await POST(createPostRequest({ drawCount: 20 }))

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock()
    primePgDb(pg)
    const pgRes = await POST(createPostRequest({ drawCount: 20 }))

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(400)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
    expect(pg.updateCalls).toHaveLength(0)
  })

  it('streamer が見つからない: 両経路とも 404 + 同一 body(UPDATE は実行されない)', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock([{ data: null }])
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await POST(createPostRequest())

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({ selects: [{ rows: [] }] })
    primePgDb(pg)
    const pgRes = await POST(createPostRequest())

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(404)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
    expect(pg.updateCalls).toHaveLength(0)
  })

  it('所有権確認の取得失敗: 両経路とも 500 + 同一 body', async () => {
    const DB_ERROR = { message: 'boom' }
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock([{ error: DB_ERROR }])
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await POST(createPostRequest())

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({ selects: [{ error: { code: '42601', message: 'syntax error' } }] })
    primePgDb(pg)
    const pgRes = await POST(createPostRequest())

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(500)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
  })

  it('UPDATE 失敗: 両経路とも 500 + 同一 body', async () => {
    const DB_ERROR = { message: 'update boom' }
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock([{ data: STREAMER_ROW }, { error: DB_ERROR }])
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await POST(createPostRequest())

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [STREAMER_ROW] }],
      updates: [{ error: { code: '42601', message: 'syntax error' } }],
    })
    primePgDb(pg)
    const pgRes = await POST(createPostRequest())

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(500)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
  })

  it('DB_DRIVER=pg-read では書き込みハンドラのため postgrest 経路のまま(getDb 不使用)', async () => {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const client = createSupabaseClientMock([{ data: STREAMER_ROW }, { data: UPDATED_ROW }])
    mockGetSupabaseAdmin.mockReturnValue(client as any)

    const res = await POST(createPostRequest())
    expect(res.status).toBe(200)
    expect(getDb).not.toHaveBeenCalled()
  })

  it('フラグ未設定時は getDb が一切呼ばれない(挙動不変の検証)', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock([{ data: STREAMER_ROW }, { data: UPDATED_ROW }])
    mockGetSupabaseAdmin.mockReturnValue(client as any)

    await POST(createPostRequest())
    expect(getDb).not.toHaveBeenCalled()
  })
})
