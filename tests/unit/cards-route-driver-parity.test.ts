/**
 * #663: POST/GET /api/cards の postgrest 経路 / pg 経路の互換テスト
 *
 * tests/unit/battle-routes-driver-parity.test.ts / tests/unit/cards-get-api.test.ts
 * と同じ流儀。POST は cards への INSERT(書き込み)を含むため DB_DRIVER=pg のときのみ
 * pg 経路(pg-read では postgrest のまま = getDb 不使用)。GET は読み取り専用のため
 * DB_DRIVER=pg-read でも pg 経路に切り替わる。
 *
 * rarity_weights は全テストで null にして recalculateIfAutoMode の内部クエリを
 * 発火させない(POST/PUT ハンドラの本質と無関係な副経路のため、テストを単純化する)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { POST, GET } from '@/app/api/cards/route'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { checkRateLimit } from '@/lib/rate-limit'
import { validateCSRFToken } from '@/lib/csrf'
import { getStorageUsage } from '@/lib/storage-usage'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getDb } from '@/lib/db/client'
import { cards as cardsTable } from '@/lib/db/schema'

vi.mock('@/lib/session')
vi.mock('@/lib/rate-limit')
vi.mock('@/lib/csrf')
vi.mock('@/lib/storage-usage')
vi.mock('@/lib/sentry/error-handler', () => ({
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}))
vi.mock('next/cache', () => ({
  unstable_cache: (fn: () => Promise<unknown>) => fn,
}))

const mockGetSession = vi.mocked(getSession)
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures)
const mockCheckRateLimit = vi.mocked(checkRateLimit)
const mockValidateCSRFToken = vi.mocked(validateCSRFToken)
const mockGetStorageUsage = vi.mocked(getStorageUsage)
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
// postgrest 経路のモック: from(table) ごとに応答キューを消費する thenable builder
// (storage-db-driver-parity.test.ts と同方式。insert 引数も記録する)
// ---------------------------------------------------------------------------

interface PostgrestResponse {
  data?: unknown
  error?: unknown
  count?: number | null
}

function createSupabaseClientMock(resultsByTable: Record<string, PostgrestResponse[]>) {
  const queues = Object.fromEntries(
    Object.entries(resultsByTable).map(([table, results]) => [table, [...results]])
  )
  const insertCalls: Array<{ table: string; values: unknown }> = []
  const from = vi.fn((table: string) => {
    const queue = queues[table]
    if (!queue || queue.length === 0) {
      throw new Error(`no mock result configured for table: ${table}`)
    }
    const response = queue.length > 1 ? queue.shift()! : queue[0]
    const resolved = { data: response.data ?? null, error: response.error ?? null, count: response.count ?? null }
    const builder: any = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      order: vi.fn(() => builder),
      range: vi.fn(() => builder),
      insert: vi.fn((values: unknown) => {
        // 呼び出し時点の値をスナップショットする(insertData はカスケードリトライで
        // 呼び出し元により破壊的に変更されるため、参照保持だと後続の変更が
        // 過去の呼び出し記録まで書き換えてしまう)
        insertCalls.push({ table, values: Array.isArray(values) ? [...values] : { ...(values as object) } })
        return builder
      }),
      maybeSingle: vi.fn(() => Promise.resolve(resolved)),
      then: (onFulfilled: any, onRejected: any) => Promise.resolve(resolved).then(onFulfilled, onRejected),
    }
    return builder
  })
  return { from, insertCalls }
}

// ---------------------------------------------------------------------------
// pg 経路のモック(twitch-sub-check-driver-parity.test.ts / battle-routes と同方式)
// ---------------------------------------------------------------------------

function createDrizzleDbMock(config: {
  selects?: Array<{ rows?: Array<Record<string, unknown>>; error?: unknown }>
  inserts?: Array<{ rows?: Array<Record<string, unknown>>; error?: unknown }>
} = {}) {
  let selectIndex = 0
  let insertIndex = 0
  const selectCalls: Array<{ fields: Record<string, unknown>; where?: unknown }> = []
  const insertCalls: Array<{ table: unknown; values?: unknown }> = []

  const db = {
    // fields は省略可(Drizzle の db.select() 引数無し = SELECT * 相当。
    // fetchCardsFromDBPg の行取得クエリがこの形で呼ぶため、未指定時は
    // フィクスチャ行をそのまま返す(射影しない)。
    select: vi.fn((fields?: Record<string, unknown>) => {
      const call: { fields: Record<string, unknown>; where?: unknown } = { fields: fields ?? {} }
      selectCalls.push(call)
      const responses = config.selects ?? [{ rows: [] }]
      const response = responses[Math.min(selectIndex, responses.length - 1)]
      selectIndex += 1
      const resolve = () =>
        response.error
          ? Promise.reject(response.error)
          : Promise.resolve(
              (response.rows ?? []).map((row) =>
                fields ? Object.fromEntries(Object.keys(fields).map((key) => [key, row[key] ?? null])) : row
              )
            )
      const builder: any = {
        from: vi.fn(() => builder),
        where: vi.fn((condition: unknown) => {
          call.where = condition
          return builder
        }),
        orderBy: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        offset: vi.fn(() => builder),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
    insert: vi.fn((table: unknown) => {
      const call: { table: unknown; values?: unknown } = { table }
      insertCalls.push(call)
      const responses = config.inserts ?? [{ rows: [] }]
      const response = responses[Math.min(insertIndex, responses.length - 1)]
      insertIndex += 1
      const builder: any = {
        values: vi.fn((values: unknown) => {
          // 呼び出し時点の値をスナップショットする(insertData はカスケードリトライで
          // 呼び出し元により破壊的に変更されるため、参照保持だと後続の変更が
          // 過去の呼び出し記録まで書き換えてしまう)
          call.values = Array.isArray(values) ? [...values] : { ...(values as object) }
          return builder
        }),
        returning: vi.fn(() =>
          response.error ? Promise.reject(response.error) : Promise.resolve(response.rows ?? [])
        ),
      }
      return builder
    }),
  }
  return { db, selectCalls, insertCalls }
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any)
}

// ---------------------------------------------------------------------------
// POST /api/cards
// ---------------------------------------------------------------------------

describe('POST /api/cards（読み書き混在: DB_DRIVER=pg のときのみ pg 経路）', () => {
  const STREAMER_ROW = { id: 'streamer1', rarity_weights: null, card_pack_names: [] }
  const CREATED_CARD_ROW = {
    id: 'card1',
    streamer_id: 'streamer1',
    name: 'Sword',
    description: '',
    image_url: 'https://example.com/a.png',
    rarity: 'common',
    drop_rate: 0.5,
    card_number: null,
    max_issuance_count: null,
    intra_rarity_weight: 1,
    collection_name: null,
    is_active: true,
  }

  function createPostRequest(body: Record<string, unknown> = {
    streamerId: 'streamer1',
    name: 'Sword',
    description: '',
    imageUrl: 'https://example.com/a.png',
    rarity: 'common',
    dropRate: 0.5,
  }): NextRequest {
    return new NextRequest('http://localhost/api/cards', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    allowRateLimit()
    mockGetSession.mockResolvedValue(SESSION)
    mockCanUseStreamerFeatures.mockReturnValue(true)
    mockValidateCSRFToken.mockResolvedValue({ valid: true })
    mockGetStorageUsage.mockResolvedValue({ planOverLimit: false } as Awaited<ReturnType<typeof getStorageUsage>>)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('成功時: 両経路のレスポンス body と cards への INSERT 値が一致する', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({
      streamers: [{ data: STREAMER_ROW }],
      cards: [{ data: CREATED_CARD_ROW }],
    })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await POST(createPostRequest())
    const postgrestBody = await postgrestRes.json()

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [STREAMER_ROW] }],
      inserts: [{ rows: [CREATED_CARD_ROW] }],
    })
    primePgDb(pg)
    const pgRes = await POST(createPostRequest())
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)
    expect(pgBody).toEqual(expect.objectContaining({ id: 'card1', name: 'Sword' }))

    expect(pg.insertCalls).toHaveLength(1)
    expect(pg.insertCalls[0].table).toBe(cardsTable)
    expect(pg.insertCalls[0].values).toEqual(client.insertCalls[0].values)
    expect(pg.insertCalls[0].values).toEqual(
      expect.objectContaining({
        streamer_id: 'streamer1',
        name: 'Sword',
        image_url: 'https://example.com/a.png',
        rarity: 'common',
        drop_rate: 0.5,
        card_number: null,
        max_issuance_count: null,
      })
    )
  })

  it('card_number 列がデプロイ窓で未検出: 両経路とも列を落として再試行し 200 で作成される', async () => {
    const MISSING_CARD_NUMBER_ERROR = {
      code: 'PGRST204',
      message: "Could not find the 'card_number' column of 'cards' in the schema cache",
    }
    const MISSING_CARD_NUMBER_ERROR_PG = {
      code: '42703',
      message: 'column "card_number" of relation "cards" does not exist',
    }
    const CREATED_WITHOUT_CARD_NUMBER = { ...CREATED_CARD_ROW }

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({
      streamers: [{ data: STREAMER_ROW }],
      cards: [{ error: MISSING_CARD_NUMBER_ERROR }, { data: CREATED_WITHOUT_CARD_NUMBER }],
    })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await POST(createPostRequest({
      streamerId: 'streamer1',
      name: 'Sword',
      description: '',
      imageUrl: 'https://example.com/a.png',
      rarity: 'common',
      dropRate: 0.5,
      cardNumber: 3,
    }))
    const postgrestBody = await postgrestRes.json()

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [STREAMER_ROW] }],
      inserts: [{ error: MISSING_CARD_NUMBER_ERROR_PG }, { rows: [CREATED_WITHOUT_CARD_NUMBER] }],
    })
    primePgDb(pg)
    const pgRes = await POST(createPostRequest({
      streamerId: 'streamer1',
      name: 'Sword',
      description: '',
      imageUrl: 'https://example.com/a.png',
      rarity: 'common',
      dropRate: 0.5,
      cardNumber: 3,
    }))
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)

    // 1 回目(card_number 込み)が失敗し、2 回目(card_number 抜き)で成功する
    expect(pg.insertCalls).toHaveLength(2)
    expect(pg.insertCalls[0].values).toHaveProperty('card_number')
    expect(pg.insertCalls[1].values).not.toHaveProperty('card_number')
  })

  it('streamer が所有者と一致しない: 両経路とも 403 + 同一 body', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({ streamers: [{ data: null }] })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await POST(createPostRequest())

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({ selects: [{ rows: [] }] })
    primePgDb(pg)
    const pgRes = await POST(createPostRequest())

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(403)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
  })

  it('card_number 一意制約違反: 両経路とも 409 + 同一 body', async () => {
    const CONFLICT_ERROR_POSTGREST = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "cards_streamer_card_number_unique"',
    }
    const CONFLICT_ERROR_PG = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "cards_streamer_card_number_unique"',
    }

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({
      streamers: [{ data: STREAMER_ROW }],
      cards: [{ error: CONFLICT_ERROR_POSTGREST }],
    })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await POST(createPostRequest({
      streamerId: 'streamer1',
      name: 'Sword',
      description: '',
      imageUrl: 'https://example.com/a.png',
      rarity: 'common',
      dropRate: 0.5,
      cardNumber: 5,
    }))

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [STREAMER_ROW] }],
      inserts: [{ error: CONFLICT_ERROR_PG }],
    })
    primePgDb(pg)
    const pgRes = await POST(createPostRequest({
      streamerId: 'streamer1',
      name: 'Sword',
      description: '',
      imageUrl: 'https://example.com/a.png',
      rarity: 'common',
      dropRate: 0.5,
      cardNumber: 5,
    }))

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(409)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
  })

  it('DB_DRIVER=pg-read では書き込みハンドラのため postgrest 経路のまま(getDb 不使用)', async () => {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const client = createSupabaseClientMock({
      streamers: [{ data: STREAMER_ROW }],
      cards: [{ data: CREATED_CARD_ROW }],
    })
    mockGetSupabaseAdmin.mockReturnValue(client as any)

    const res = await POST(createPostRequest())
    expect(res.status).toBe(200)
    expect(getDb).not.toHaveBeenCalled()
  })

  it('フラグ未設定時は getDb が一切呼ばれない(挙動不変の検証)', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({
      streamers: [{ data: STREAMER_ROW }],
      cards: [{ data: CREATED_CARD_ROW }],
    })
    mockGetSupabaseAdmin.mockReturnValue(client as any)

    await POST(createPostRequest())
    expect(getDb).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// GET /api/cards
// ---------------------------------------------------------------------------

describe('GET /api/cards（読み取り専用: DB_DRIVER=pg-read でも pg 経路）', () => {
  const STREAMER_OWNERSHIP_ROW = { id: 'streamer1' }
  const CARD_ROW = {
    id: 'card1',
    streamer_id: 'streamer1',
    name: 'Sword',
    rarity: 'common',
    rarity_order: 4,
    drop_rate: 0.5,
    card_number: null,
    max_issuance_count: null,
    created_at: '2026-01-01 00:00:00+00',
    updated_at: '2026-01-01 00:00:00+00',
  }

  function createGetRequest(streamerId = 'streamer1'): NextRequest {
    const url = new URL('http://localhost/api/cards')
    url.searchParams.set('streamerId', streamerId)
    return new NextRequest(url)
  }

  function run(driver: string | undefined) {
    vi.stubEnv('DB_DRIVER', driver)
    return GET(createGetRequest())
  }

  beforeEach(() => {
    vi.clearAllMocks()
    allowRateLimit()
    mockGetSession.mockResolvedValue(SESSION)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('成功時: 両経路のレスポンス body(cards + pagination)が完全一致する', async () => {
    const client = createSupabaseClientMock({
      streamers: [{ data: STREAMER_OWNERSHIP_ROW }],
      cards: [{ data: [CARD_ROW], count: 1 }],
    })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await run(undefined)
    const postgrestBody = await postgrestRes.json()

    const pg = createDrizzleDbMock({
      selects: [
        { rows: [STREAMER_OWNERSHIP_ROW] },
        { rows: [{ value: 1 }] },
        { rows: [CARD_ROW] },
      ],
    })
    primePgDb(pg)
    const pgRes = await run('pg-read')
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)
    expect(pgBody.cards).toHaveLength(1)
    expect(pgBody.pagination).toEqual({ total: 1, limit: 12, offset: 0, hasMore: false })
  })

  it('streamer が所有者と一致しない: 両経路とも 403 + 同一 body', async () => {
    const client = createSupabaseClientMock({ streamers: [{ data: null }] })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await run(undefined)

    const pg = createDrizzleDbMock({ selects: [{ rows: [] }] })
    primePgDb(pg)
    const pgRes = await run('pg-read')

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(403)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
  })

  it('フラグ未設定時は getDb が一切呼ばれない(挙動不変の検証)', async () => {
    const client = createSupabaseClientMock({
      streamers: [{ data: STREAMER_OWNERSHIP_ROW }],
      cards: [{ data: [CARD_ROW], count: 1 }],
    })
    mockGetSupabaseAdmin.mockReturnValue(client as any)

    await run(undefined)
    expect(getDb).not.toHaveBeenCalled()
  })
})
