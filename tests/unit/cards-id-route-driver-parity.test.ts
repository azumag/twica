/**
 * #663: PUT/DELETE /api/cards/[id] の postgrest 経路 / pg 経路の互換テスト
 *
 * tests/unit/battle-routes-driver-parity.test.ts と同じ流儀。PUT/DELETE はいずれも
 * cards への書き込み(UPDATE/DELETE)を含むハンドラのため、DB_DRIVER=pg のときのみ
 * pg 経路に切り替わる(pg-read では postgrest のまま = getDb 不使用)。
 *
 * rarity_weights は全テストで null にして recalculateIfAutoMode の内部クエリを
 * 発火させない(PUT/DELETE ハンドラの本質と無関係な副経路のため単純化する)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { PUT, DELETE } from '@/app/api/cards/[id]/route'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { checkRateLimit } from '@/lib/rate-limit'
import { validateCSRFToken } from '@/lib/csrf'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getDb } from '@/lib/db/client'
import { cards as cardsTable } from '@/lib/db/schema'

vi.mock('@/lib/session')
vi.mock('@/lib/rate-limit')
vi.mock('@/lib/csrf')
vi.mock('@/lib/sentry/error-handler', () => ({
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}))

const mockGetSession = vi.mocked(getSession)
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures)
const mockCheckRateLimit = vi.mocked(checkRateLimit)
const mockValidateCSRFToken = vi.mocked(validateCSRFToken)
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
// ---------------------------------------------------------------------------

interface PostgrestResponse {
  data?: unknown
  error?: unknown
}

function createSupabaseClientMock(resultsByTable: Record<string, PostgrestResponse[]>) {
  const queues = Object.fromEntries(
    Object.entries(resultsByTable).map(([table, results]) => [table, [...results]])
  )
  const updateCalls: Array<{ table: string; values: unknown }> = []
  const deleteCalls: Array<{ table: string }> = []
  const from = vi.fn((table: string) => {
    const queue = queues[table]
    if (!queue || queue.length === 0) {
      throw new Error(`no mock result configured for table: ${table}`)
    }
    const response = queue.length > 1 ? queue.shift()! : queue[0]
    const resolved = { data: response.data ?? null, error: response.error ?? null }
    const builder: any = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      update: vi.fn((values: unknown) => {
        // 呼び出し時点の値をスナップショットする(updateData はカスケードリトライで
        // 呼び出し元により破壊的に変更されるため、参照保持だと後続の変更が
        // 過去の呼び出し記録まで書き換えてしまう)
        updateCalls.push({ table, values: { ...(values as object) } })
        return builder
      }),
      delete: vi.fn(() => {
        deleteCalls.push({ table })
        return builder
      }),
      maybeSingle: vi.fn(() => Promise.resolve(resolved)),
      then: (onFulfilled: any, onRejected: any) => Promise.resolve(resolved).then(onFulfilled, onRejected),
    }
    return builder
  })
  return { from, updateCalls, deleteCalls }
}

// ---------------------------------------------------------------------------
// pg 経路のモック
// ---------------------------------------------------------------------------

function createDrizzleDbMock(config: {
  selects?: Array<{ rows?: Array<Record<string, unknown>>; error?: unknown }>
  updates?: Array<{ rows?: Array<Record<string, unknown>>; error?: unknown }>
  deletes?: Array<{ error?: unknown }>
} = {}) {
  let selectIndex = 0
  let updateIndex = 0
  let deleteIndex = 0
  const updateCalls: Array<{ table: unknown; set?: unknown; where?: unknown }> = []
  const deleteCalls: Array<{ table: unknown; where?: unknown }> = []

  const db = {
    select: vi.fn((fields?: Record<string, unknown>) => {
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
        innerJoin: vi.fn(() => builder),
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
          // 呼び出し時点の値をスナップショットする(updateData はカスケードリトライで
          // 呼び出し元により破壊的に変更されるため、参照保持だと後続の変更が
          // 過去の呼び出し記録まで書き換えてしまう)
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
    delete: vi.fn((table: unknown) => {
      const call: { table: unknown; where?: unknown } = { table }
      deleteCalls.push(call)
      const responses = config.deletes ?? [{}]
      const response = responses[Math.min(deleteIndex, responses.length - 1)]
      deleteIndex += 1
      const builder: any = {
        where: vi.fn((condition: unknown) => {
          call.where = condition
          return response.error ? Promise.reject(response.error) : Promise.resolve([])
        }),
      }
      return builder
    }),
  }
  return { db, updateCalls, deleteCalls }
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any)
}

// ---------------------------------------------------------------------------
// PUT /api/cards/[id]
// ---------------------------------------------------------------------------

describe('PUT /api/cards/[id]（読み書き混在: DB_DRIVER=pg のときのみ pg 経路）', () => {
  const CARD_ID = 'card1'

  function ownershipRow(overrides: Record<string, unknown> = {}) {
    return {
      streamer_id: 'streamer1',
      image_url: null,
      rarity: 'common',
      is_active: true,
      intra_rarity_weight: 1,
      collection_name: null,
      ...overrides,
    }
  }

  function postgrestOwnershipData(overrides: Record<string, unknown> = {}) {
    return {
      ...ownershipRow(overrides),
      streamers: { twitch_user_id: 'user1', rarity_weights: null, card_pack_names: [] },
    }
  }

  function pgOwnershipRow(overrides: Record<string, unknown> = {}) {
    return {
      ...ownershipRow(overrides),
      s_twitch_user_id: 'user1',
      s_rarity_weights: null,
      s_card_pack_names: [],
    }
  }

  function createPutRequest(body: Record<string, unknown> = { name: 'Renamed' }): NextRequest {
    return new NextRequest(`http://localhost/api/cards/${CARD_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  function runPut(body?: Record<string, unknown>) {
    return PUT(createPutRequest(body), { params: Promise.resolve({ id: CARD_ID }) })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    allowRateLimit()
    mockGetSession.mockResolvedValue(SESSION)
    mockCanUseStreamerFeatures.mockReturnValue(true)
    mockValidateCSRFToken.mockResolvedValue({ valid: true })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('成功時: 両経路のレスポンス body と cards への UPDATE 値が一致する', async () => {
    const UPDATED_ROW = { id: CARD_ID, name: 'Renamed', collection_name: null }

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({
      cards: [{ data: postgrestOwnershipData() }, { data: UPDATED_ROW }],
    })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await runPut()
    const postgrestBody = await postgrestRes.json()

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [pgOwnershipRow()] }],
      updates: [{ rows: [UPDATED_ROW] }],
    })
    primePgDb(pg)
    const pgRes = await runPut()
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)

    expect(pg.updateCalls).toHaveLength(1)
    expect(pg.updateCalls[0].table).toBe(cardsTable)
    expect(pg.updateCalls[0].set).toEqual(client.updateCalls[0].values)
    expect(pg.updateCalls[0].set).toEqual({ name: 'Renamed' })
  })

  it('max_issuance_count 列がデプロイ窓で未検出: 両経路とも列を落として再試行し 200 で更新される', async () => {
    const MISSING_ISSUANCE_ERROR = {
      code: 'PGRST204',
      message: "Could not find the 'max_issuance_count' column of 'cards' in the schema cache",
    }
    const MISSING_ISSUANCE_ERROR_PG = {
      code: '42703',
      message: 'column "max_issuance_count" of relation "cards" does not exist',
    }
    const UPDATED_ROW = { id: CARD_ID, name: 'Renamed' }

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({
      cards: [{ data: postgrestOwnershipData() }, { error: MISSING_ISSUANCE_ERROR }, { data: UPDATED_ROW }],
    })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await runPut({ name: 'Renamed', maxIssuanceCount: 10 })
    const postgrestBody = await postgrestRes.json()

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [pgOwnershipRow()] }],
      updates: [{ error: MISSING_ISSUANCE_ERROR_PG }, { rows: [UPDATED_ROW] }],
    })
    primePgDb(pg)
    const pgRes = await runPut({ name: 'Renamed', maxIssuanceCount: 10 })
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)

    expect(pg.updateCalls).toHaveLength(2)
    expect(pg.updateCalls[0].set).toHaveProperty('max_issuance_count')
    expect(pg.updateCalls[1].set).not.toHaveProperty('max_issuance_count')
  })

  it('所有者が一致しない(twitch_user_id 不一致): 両経路とも 403 + 同一 body', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({
      cards: [{
        data: {
          ...ownershipRow(),
          streamers: { twitch_user_id: 'someone-else', rarity_weights: null, card_pack_names: [] },
        },
      }],
    })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await runPut()

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [{ ...pgOwnershipRow(), s_twitch_user_id: 'someone-else' }] }],
    })
    primePgDb(pg)
    const pgRes = await runPut()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(403)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
    expect(pg.updateCalls).toHaveLength(0)
  })

  it('card_number 一意制約違反: 両経路とも 409 + 同一 body', async () => {
    const CONFLICT_ERROR = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "cards_streamer_card_number_unique"',
    }

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({
      cards: [{ data: postgrestOwnershipData() }, { error: CONFLICT_ERROR }],
    })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await runPut({ cardNumber: 5 })

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [pgOwnershipRow()] }],
      updates: [{ error: CONFLICT_ERROR }],
    })
    primePgDb(pg)
    const pgRes = await runPut({ cardNumber: 5 })

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(409)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
  })

  it('DB_DRIVER=pg-read では書き込みハンドラのため postgrest 経路のまま(getDb 不使用)', async () => {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const client = createSupabaseClientMock({
      cards: [{ data: postgrestOwnershipData() }, { data: { id: CARD_ID, name: 'Renamed' } }],
    })
    mockGetSupabaseAdmin.mockReturnValue(client as any)

    const res = await runPut()
    expect(res.status).toBe(200)
    expect(getDb).not.toHaveBeenCalled()
  })

  it('フラグ未設定時は getDb が一切呼ばれない(挙動不変の検証)', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({
      cards: [{ data: postgrestOwnershipData() }, { data: { id: CARD_ID, name: 'Renamed' } }],
    })
    mockGetSupabaseAdmin.mockReturnValue(client as any)

    await runPut()
    expect(getDb).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/cards/[id]
// ---------------------------------------------------------------------------

describe('DELETE /api/cards/[id]（読み書き混在: DB_DRIVER=pg のときのみ pg 経路）', () => {
  const CARD_ID = 'card1'

  function postgrestOwnershipData(twitchUserId = 'user1') {
    return {
      streamer_id: 'streamer1',
      image_url: null,
      streamers: { twitch_user_id: twitchUserId, rarity_weights: null },
    }
  }

  function pgOwnershipRow(twitchUserId = 'user1') {
    return {
      streamer_id: 'streamer1',
      image_url: null,
      s_twitch_user_id: twitchUserId,
      s_rarity_weights: null,
    }
  }

  function createDeleteRequest(): NextRequest {
    return new NextRequest(`http://localhost/api/cards/${CARD_ID}`, { method: 'DELETE' })
  }

  function runDelete() {
    return DELETE(createDeleteRequest(), { params: Promise.resolve({ id: CARD_ID }) })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    allowRateLimit()
    mockGetSession.mockResolvedValue(SESSION)
    mockCanUseStreamerFeatures.mockReturnValue(true)
    mockValidateCSRFToken.mockResolvedValue({ valid: true })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('成功時: 両経路のレスポンス body と cards への DELETE の where 条件が一致する', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({ cards: [{ data: postgrestOwnershipData() }] })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await runDelete()
    const postgrestBody = await postgrestRes.json()

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({ selects: [{ rows: [pgOwnershipRow()] }] })
    primePgDb(pg)
    const pgRes = await runDelete()
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)
    expect(pgBody).toEqual({ success: true, recalculatedCards: null })

    expect(pg.deleteCalls).toHaveLength(1)
    expect(pg.deleteCalls[0].table).toBe(cardsTable)
    expect(client.deleteCalls).toHaveLength(1)
  })

  it('所有者が一致しない: 両経路とも 403 + 同一 body(DELETE は実行されない)', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({ cards: [{ data: postgrestOwnershipData('someone-else') }] })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await runDelete()

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({ selects: [{ rows: [pgOwnershipRow('someone-else')] }] })
    primePgDb(pg)
    const pgRes = await runDelete()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(403)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
    expect(pg.deleteCalls).toHaveLength(0)
  })

  it('DELETE 失敗: 両経路とも 500 + 同一 body', async () => {
    const DB_ERROR = { message: 'boom' }

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({ cards: [{ data: postgrestOwnershipData() }, { error: DB_ERROR }] })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await runDelete()

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [pgOwnershipRow()] }],
      deletes: [{ error: { code: '42601', message: 'syntax error' } }],
    })
    primePgDb(pg)
    const pgRes = await runDelete()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(500)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
  })

  it('フラグ未設定時は getDb が一切呼ばれない(挙動不変の検証)', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({ cards: [{ data: postgrestOwnershipData() }] })
    mockGetSupabaseAdmin.mockReturnValue(client as any)

    await runDelete()
    expect(getDb).not.toHaveBeenCalled()
  })
})
