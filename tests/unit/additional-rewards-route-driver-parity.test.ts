/**
 * #663 Batch C: GET/POST/DELETE /api/streamer/additional-rewards の
 * postgrest 経路 / pg 経路の互換テスト。
 *
 * tests/unit/cards-route-driver-parity.test.ts / cards-id-route-driver-parity.test.ts
 * と同じ流儀（from(table) ごとに応答キューを消費する thenable builder）。
 *
 * フラグ使い分け:
 * - GET は読み取り専用のため isPgReadEnabled() で分岐（DB_DRIVER=pg-read でも pg 経路）。
 * - POST/DELETE は streamer_additional_gacha_rewards への書き込み(INSERT/DELETE)を
 *   含むため、所有権確認(streamers select)も含めてリクエスト全体を
 *   isPgWriteEnabled() で分岐する（DB_DRIVER=pg のときのみ pg 経路。pg-read では
 *   postgrest のまま = getDb 不使用）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET, POST, DELETE } from '@/app/api/streamer/additional-rewards/route'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { checkRateLimit } from '@/lib/rate-limit'
import { validateCSRFToken } from '@/lib/csrf'
import { validateContentType } from '@/lib/request-validation'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getDb } from '@/lib/db/client'
import { streamerAdditionalGachaRewards as rewardsTable } from '@/lib/db/schema'

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
// postgrest 経路のモック: from(table) ごとに応答キューを消費する thenable builder
// (cards-route-driver-parity.test.ts と同方式)
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
  const deleteCalls: Array<{ table: string }> = []
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
      is: vi.fn(() => builder),
      order: vi.fn(() => builder),
      insert: vi.fn((values: unknown) => {
        // 呼び出し時点の値をスナップショットする(insertData はカスケードリトライで
        // 呼び出し元により破壊的に変更されるため、参照保持だと後続の変更が
        // 過去の呼び出し記録まで書き換えてしまう)
        insertCalls.push({ table, values: { ...(values as object) } })
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
  return { from, insertCalls, deleteCalls }
}

// ---------------------------------------------------------------------------
// pg 経路のモック(cards-route-driver-parity.test.ts と同方式。delete は
// 「.where() 直後に await」(単一削除)と「.where().returning()」(全削除)の
// 両方の呼び出し形に対応する)
// ---------------------------------------------------------------------------

function createDrizzleDbMock(config: {
  selects?: Array<{ rows?: Array<Record<string, unknown>>; error?: unknown }>
  inserts?: Array<{ rows?: Array<Record<string, unknown>>; error?: unknown }>
  deletes?: Array<{ rows?: Array<Record<string, unknown>>; error?: unknown }>
} = {}) {
  let selectIndex = 0
  let insertIndex = 0
  let deleteIndex = 0
  const selectCalls: Array<{ fields: Record<string, unknown> }> = []
  const insertCalls: Array<{ table: unknown; values?: unknown }> = []
  const deleteCalls: Array<{ table: unknown; where?: unknown }> = []

  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      selectCalls.push({ fields })
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
        orderBy: vi.fn(() => builder),
        limit: vi.fn(() => builder),
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
          call.values = { ...(values as object) }
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
      const responses = config.deletes ?? [{ rows: [] }]
      const response = responses[Math.min(deleteIndex, responses.length - 1)]
      deleteIndex += 1
      const builder: any = {
        where: vi.fn((condition: unknown) => {
          call.where = condition
          const settle = () =>
            response.error ? Promise.reject(response.error) : Promise.resolve(response.rows ?? [])
          return {
            returning: vi.fn(() => settle()),
            then: (onFulfilled: any, onRejected: any) => settle().then(onFulfilled, onRejected),
          }
        }),
      }
      return builder
    }),
  }
  return { db, selectCalls, insertCalls, deleteCalls }
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
// GET /api/streamer/additional-rewards
// ---------------------------------------------------------------------------

describe('GET /api/streamer/additional-rewards（読み取り専用: DB_DRIVER=pg-read でも pg 経路）', () => {
  const STREAMER_ROW = { id: 'streamer1' }
  const REWARD_ROW = {
    id: 'reward1',
    reward_id: 'twitch-reward-1',
    reward_name: 'Extra Draw',
    draw_count: 3,
    is_raid_limited: true,
    collection_name: 'weapons',
    created_at: '2026-01-01 00:00:00+00',
  }

  function run(driver: string | undefined) {
    vi.stubEnv('DB_DRIVER', driver)
    return GET(new NextRequest('http://localhost/api/streamer/additional-rewards'))
  }

  it('成功時: 両経路の一覧レスポンスが一致する', async () => {
    const client = createSupabaseClientMock({
      streamers: [{ data: STREAMER_ROW }],
      streamer_additional_gacha_rewards: [{ data: [REWARD_ROW] }],
    })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await run(undefined)
    const postgrestBody = await postgrestRes.json()

    const pg = createDrizzleDbMock({
      selects: [{ rows: [STREAMER_ROW] }, { rows: [REWARD_ROW] }],
    })
    primePgDb(pg)
    const pgRes = await run('pg-read')
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)
    expect(pgBody).toEqual([expect.objectContaining({ reward_id: 'twitch-reward-1', draw_count: 3 })])
  })

  it('streamer が見つからない: 両経路とも 404 + 同一 body', async () => {
    const client = createSupabaseClientMock({ streamers: [{ data: null }] })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await run(undefined)

    const pg = createDrizzleDbMock({ selects: [{ rows: [] }] })
    primePgDb(pg)
    const pgRes = await run('pg-read')

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(404)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
  })

  it('collection_name 列がデプロイ窓で未検出(READ 42703): 両経路とも draw_count/is_raid_limited を保持しつつ collection_name: null にフォールバックする', async () => {
    const MISSING_COLLECTION_ERROR = {
      code: '42703',
      message: 'column streamer_additional_gacha_rewards.collection_name does not exist',
    }
    const FALLBACK_ROW = { ...REWARD_ROW, collection_name: undefined }
    delete (FALLBACK_ROW as Record<string, unknown>).collection_name

    const client = createSupabaseClientMock({
      streamers: [{ data: STREAMER_ROW }],
      streamer_additional_gacha_rewards: [{ error: MISSING_COLLECTION_ERROR }, { data: [FALLBACK_ROW] }],
    })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await run(undefined)
    const postgrestBody = await postgrestRes.json()

    const pg = createDrizzleDbMock({
      selects: [
        { rows: [STREAMER_ROW] },
        { error: MISSING_COLLECTION_ERROR },
        { rows: [FALLBACK_ROW] },
      ],
    })
    primePgDb(pg)
    const pgRes = await run('pg-read')
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)
    expect(pgBody).toEqual([
      expect.objectContaining({ draw_count: 3, is_raid_limited: true, collection_name: null }),
    ])
  })

  it('raid options 列がデプロイ窓で未検出(PGRST204相当): 両経路とも draw_count: 1, is_raid_limited: false にフォールバックする', async () => {
    const MISSING_RAID_OPTIONS_ERROR = { code: 'PGRST204', message: "Could not find the 'draw_count' column" }
    const LEGACY_ROW = {
      id: 'reward1',
      reward_id: 'twitch-reward-1',
      reward_name: 'Legacy',
      created_at: '2026-01-01 00:00:00+00',
    }

    const client = createSupabaseClientMock({
      streamers: [{ data: STREAMER_ROW }],
      streamer_additional_gacha_rewards: [{ error: MISSING_RAID_OPTIONS_ERROR }, { data: [LEGACY_ROW] }],
    })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await run(undefined)
    const postgrestBody = await postgrestRes.json()

    const pg = createDrizzleDbMock({
      selects: [
        { rows: [STREAMER_ROW] },
        { error: MISSING_RAID_OPTIONS_ERROR },
        { rows: [LEGACY_ROW] },
      ],
    })
    primePgDb(pg)
    const pgRes = await run('pg-read')
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)
    expect(pgBody).toEqual([
      expect.objectContaining({ reward_id: 'twitch-reward-1', draw_count: 1, is_raid_limited: false, collection_name: null }),
    ])
  })

  it('取得失敗(未知のエラー): 両経路とも 500 + 同一 body', async () => {
    const DB_ERROR = { message: 'boom' }
    const client = createSupabaseClientMock({
      streamers: [{ data: STREAMER_ROW }],
      streamer_additional_gacha_rewards: [{ error: DB_ERROR }],
    })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await run(undefined)

    const pg = createDrizzleDbMock({
      selects: [{ rows: [STREAMER_ROW] }, { error: { code: '42601', message: 'syntax error' } }],
    })
    primePgDb(pg)
    const pgRes = await run('pg-read')

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(500)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
  })

  it('フラグ未設定時は getDb が一切呼ばれない(挙動不変の検証)', async () => {
    const client = createSupabaseClientMock({
      streamers: [{ data: STREAMER_ROW }],
      streamer_additional_gacha_rewards: [{ data: [REWARD_ROW] }],
    })
    mockGetSupabaseAdmin.mockReturnValue(client as any)

    await run(undefined)
    expect(getDb).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// POST /api/streamer/additional-rewards
// ---------------------------------------------------------------------------

describe('POST /api/streamer/additional-rewards（読み書き混在: DB_DRIVER=pg のときのみ pg 経路）', () => {
  const STREAMER_ROW = { id: 'streamer1', channel_point_reward_id: 'main-reward', card_pack_names: [] as string[] }
  const CREATED_REWARD_ROW = {
    id: 'additional-1',
    streamer_id: 'streamer1',
    reward_id: 'extra-reward',
    reward_name: 'Weapons',
    draw_count: 1,
    is_raid_limited: false,
    collection_name: null,
    created_at: '2026-01-01 00:00:00+00',
  }

  function createPostRequest(body: Record<string, unknown> = { rewardId: 'extra-reward', rewardName: 'Weapons' }): NextRequest {
    return new NextRequest('http://localhost/api/streamer/additional-rewards', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('成功時(パック紐付けなし): 両経路のレスポンス body と INSERT 値が一致する', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({
      streamers: [{ data: STREAMER_ROW }],
      streamer_additional_gacha_rewards: [{ data: CREATED_REWARD_ROW }],
    })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await POST(createPostRequest())
    const postgrestBody = await postgrestRes.json()

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [STREAMER_ROW] }],
      inserts: [{ rows: [CREATED_REWARD_ROW] }],
    })
    primePgDb(pg)
    const pgRes = await POST(createPostRequest())
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)

    expect(pg.insertCalls).toHaveLength(1)
    expect(pg.insertCalls[0].table).toBe(rewardsTable)
    expect(pg.insertCalls[0].values).toEqual(client.insertCalls[0].values)
    expect(pg.insertCalls[0].values).toEqual(
      expect.objectContaining({ streamer_id: 'streamer1', reward_id: 'extra-reward', draw_count: 1, is_raid_limited: false })
    )
    expect(pg.insertCalls[0].values).not.toHaveProperty('collection_name')
  })

  it('成功時(パック紐付けあり・アクティブカードが存在): 両経路のレスポンス body が一致する', async () => {
    const streamerWithPack = { ...STREAMER_ROW, card_pack_names: ['weapons'] }
    const createdWithPack = { ...CREATED_REWARD_ROW, collection_name: 'weapons' }

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({
      streamers: [{ data: streamerWithPack }],
      cards: [{ count: 2 }],
      streamer_additional_gacha_rewards: [{ data: createdWithPack }],
    })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await POST(createPostRequest({ rewardId: 'extra-reward', rewardName: 'Weapons', collectionName: 'weapons' }))
    const postgrestBody = await postgrestRes.json()

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [streamerWithPack] }, { rows: [{ count: 2 }] }],
      inserts: [{ rows: [createdWithPack] }],
    })
    primePgDb(pg)
    const pgRes = await POST(createPostRequest({ rewardId: 'extra-reward', rewardName: 'Weapons', collectionName: 'weapons' }))
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)
    expect(pg.insertCalls[0].values).toEqual(expect.objectContaining({ collection_name: 'weapons' }))
  })

  it('メイン報酬が未設定: 両経路とも 400 + 同一 body(INSERT は実行されない)', async () => {
    const streamerWithoutMainReward = { id: 'streamer1', channel_point_reward_id: null, card_pack_names: [] as string[] }

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({ streamers: [{ data: streamerWithoutMainReward }] })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await POST(createPostRequest())

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({ selects: [{ rows: [streamerWithoutMainReward] }] })
    primePgDb(pg)
    const pgRes = await POST(createPostRequest())

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(400)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
    expect(pg.insertCalls).toHaveLength(0)
  })

  it('card_pack_names 列がデプロイ窓で未検出: 両経路ともパック紐付けを落として作成を継続する(collectionNameSkippedDeployWindow: true)', async () => {
    const MISSING_CARD_PACK_NAMES_ERROR_POSTGREST = { code: '42703', message: 'column streamers.card_pack_names does not exist' }
    const MISSING_CARD_PACK_NAMES_ERROR_PG = { code: '42703', message: 'column "card_pack_names" of relation "streamers" does not exist' }
    const STREAMER_WITHOUT_PACK_NAMES = { id: 'streamer1', channel_point_reward_id: 'main-reward' }
    const CREATED_SKIPPED = { ...CREATED_REWARD_ROW, collection_name: null }

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({
      streamers: [{ error: MISSING_CARD_PACK_NAMES_ERROR_POSTGREST }, { data: STREAMER_WITHOUT_PACK_NAMES }],
      streamer_additional_gacha_rewards: [{ data: CREATED_SKIPPED }],
    })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await POST(createPostRequest({ rewardId: 'extra-reward', rewardName: 'Weapons', collectionName: 'weapons' }))
    const postgrestBody = await postgrestRes.json()

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ error: MISSING_CARD_PACK_NAMES_ERROR_PG }, { rows: [STREAMER_WITHOUT_PACK_NAMES] }],
      inserts: [{ rows: [CREATED_SKIPPED] }],
    })
    primePgDb(pg)
    const pgRes = await POST(createPostRequest({ rewardId: 'extra-reward', rewardName: 'Weapons', collectionName: 'weapons' }))
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)
    expect(pgBody.collectionNameSkippedDeployWindow).toBe(true)
    expect(pg.insertCalls[0].values).not.toHaveProperty('collection_name')
  })

  it('collection_name 列が INSERT 時にデプロイ窓で未検出: 両経路とも列を落として再試行し 200 で作成される', async () => {
    const MISSING_COLLECTION_ERROR_POSTGREST = { code: 'PGRST204', message: "Could not find the 'collection_name' column" }
    const MISSING_COLLECTION_ERROR_PG = { code: '42703', message: 'column "collection_name" of relation "streamer_additional_gacha_rewards" does not exist' }
    const streamerWithPack = { ...STREAMER_ROW, card_pack_names: ['weapons'] }
    const CREATED_WITHOUT_COLLECTION = { ...CREATED_REWARD_ROW }

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({
      streamers: [{ data: streamerWithPack }],
      cards: [{ count: 1 }],
      streamer_additional_gacha_rewards: [{ error: MISSING_COLLECTION_ERROR_POSTGREST }, { data: CREATED_WITHOUT_COLLECTION }],
    })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await POST(createPostRequest({ rewardId: 'extra-reward', rewardName: 'Weapons', collectionName: 'weapons' }))
    const postgrestBody = await postgrestRes.json()

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [streamerWithPack] }, { rows: [{ count: 1 }] }],
      inserts: [{ error: MISSING_COLLECTION_ERROR_PG }, { rows: [CREATED_WITHOUT_COLLECTION] }],
    })
    primePgDb(pg)
    const pgRes = await POST(createPostRequest({ rewardId: 'extra-reward', rewardName: 'Weapons', collectionName: 'weapons' }))
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)
    expect(pg.insertCalls).toHaveLength(2)
    expect(pg.insertCalls[0].values).toHaveProperty('collection_name')
    expect(pg.insertCalls[1].values).not.toHaveProperty('collection_name')
  })

  it('raid options 列がデプロイ窓で未検出: 両経路とも 503 + 同一 body(フォールバック作成はしない)', async () => {
    const MISSING_RAID_OPTIONS_ERROR = { code: 'PGRST204', message: "Could not find the 'draw_count' column" }

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({
      streamers: [{ data: STREAMER_ROW }],
      streamer_additional_gacha_rewards: [{ error: MISSING_RAID_OPTIONS_ERROR }],
    })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await POST(createPostRequest({ rewardId: 'extra-reward', rewardName: 'Weapons', drawCount: 5 }))
    const postgrestBody = await postgrestRes.json()

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [STREAMER_ROW] }],
      inserts: [{ error: MISSING_RAID_OPTIONS_ERROR }],
    })
    primePgDb(pg)
    const pgRes = await POST(createPostRequest({ rewardId: 'extra-reward', rewardName: 'Weapons', drawCount: 5 }))
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(503)
    expect(pgBody).toEqual(postgrestBody)
  })

  it('一意制約違反(23505): 両経路とも 409 + 同一 body', async () => {
    const CONFLICT_ERROR = { code: '23505', message: 'duplicate key value violates unique constraint "streamer_additional_gacha_rewards_streamer_id_reward_id_key"' }

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({
      streamers: [{ data: STREAMER_ROW }],
      streamer_additional_gacha_rewards: [{ error: CONFLICT_ERROR }],
    })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await POST(createPostRequest())

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [STREAMER_ROW] }],
      inserts: [{ error: CONFLICT_ERROR }],
    })
    primePgDb(pg)
    const pgRes = await POST(createPostRequest())

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(409)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
  })

  it('streamer が見つからない: 両経路とも 404 + 同一 body(INSERT は実行されない)', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({ streamers: [{ data: null }] })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await POST(createPostRequest())

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({ selects: [{ rows: [] }] })
    primePgDb(pg)
    const pgRes = await POST(createPostRequest())

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(404)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
    expect(pg.insertCalls).toHaveLength(0)
  })

  it('DB_DRIVER=pg-read では書き込みハンドラのため postgrest 経路のまま(getDb 不使用)', async () => {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const client = createSupabaseClientMock({
      streamers: [{ data: STREAMER_ROW }],
      streamer_additional_gacha_rewards: [{ data: CREATED_REWARD_ROW }],
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
      streamer_additional_gacha_rewards: [{ data: CREATED_REWARD_ROW }],
    })
    mockGetSupabaseAdmin.mockReturnValue(client as any)

    await POST(createPostRequest())
    expect(getDb).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/streamer/additional-rewards
// ---------------------------------------------------------------------------

describe('DELETE /api/streamer/additional-rewards（読み書き混在: DB_DRIVER=pg のときのみ pg 経路）', () => {
  const STREAMER_ROW = { id: 'streamer1' }

  function createDeleteRequest(query: string): NextRequest {
    return new NextRequest(`http://localhost/api/streamer/additional-rewards?${query}`, { method: 'DELETE' })
  }

  it('deleteAll=true 成功: 両経路とも { success: true, deletedCount: null }(既存実装の count quirk に合わせたパリティ)', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({ streamers: [{ data: STREAMER_ROW }], streamer_additional_gacha_rewards: [{ data: [{ id: 'r1' }, { id: 'r2' }], count: null }] })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await DELETE(createDeleteRequest('deleteAll=true'))
    const postgrestBody = await postgrestRes.json()

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [STREAMER_ROW] }],
      deletes: [{ rows: [{ id: 'r1' }, { id: 'r2' }] }],
    })
    primePgDb(pg)
    const pgRes = await DELETE(createDeleteRequest('deleteAll=true'))
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)
    expect(pgBody).toEqual({ success: true, deletedCount: null })
    expect(pg.deleteCalls).toHaveLength(1)
    expect(pg.deleteCalls[0].table).toBe(rewardsTable)
  })

  it('rewardId 指定の単一削除成功: 両経路とも { success: true }', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({ streamers: [{ data: STREAMER_ROW }], streamer_additional_gacha_rewards: [{ error: null }] })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await DELETE(createDeleteRequest('rewardId=extra-reward'))
    const postgrestBody = await postgrestRes.json()

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [STREAMER_ROW] }],
      deletes: [{ rows: [] }],
    })
    primePgDb(pg)
    const pgRes = await DELETE(createDeleteRequest('rewardId=extra-reward'))
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)
    expect(pgBody).toEqual({ success: true })
  })

  it('streamer が見つからない: 両経路とも 404 + 同一 body', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({ streamers: [{ data: null }] })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await DELETE(createDeleteRequest('deleteAll=true'))

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({ selects: [{ rows: [] }] })
    primePgDb(pg)
    const pgRes = await DELETE(createDeleteRequest('deleteAll=true'))

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(404)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
  })

  it('DELETE 失敗(deleteAll): 両経路とも 500 + 同一 body', async () => {
    const DB_ERROR = { message: 'boom' }
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({ streamers: [{ data: STREAMER_ROW }], streamer_additional_gacha_rewards: [{ error: DB_ERROR }] })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await DELETE(createDeleteRequest('deleteAll=true'))

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [STREAMER_ROW] }],
      deletes: [{ error: { code: '42601', message: 'syntax error' } }],
    })
    primePgDb(pg)
    const pgRes = await DELETE(createDeleteRequest('deleteAll=true'))

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(500)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
  })

  it('rewardId も deleteAll も無い: 両経路とも 400 + 同一 body', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({ streamers: [{ data: STREAMER_ROW }] })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await DELETE(createDeleteRequest(''))

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({ selects: [{ rows: [STREAMER_ROW] }] })
    primePgDb(pg)
    const pgRes = await DELETE(createDeleteRequest(''))

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(400)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
  })

  it('DB_DRIVER=pg-read では書き込みハンドラのため postgrest 経路のまま(getDb 不使用)', async () => {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const client = createSupabaseClientMock({ streamers: [{ data: STREAMER_ROW }], streamer_additional_gacha_rewards: [{ data: [], count: null }] })
    mockGetSupabaseAdmin.mockReturnValue(client as any)

    const res = await DELETE(createDeleteRequest('deleteAll=true'))
    expect(res.status).toBe(200)
    expect(getDb).not.toHaveBeenCalled()
  })

  it('フラグ未設定時は getDb が一切呼ばれない(挙動不変の検証)', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({ streamers: [{ data: STREAMER_ROW }], streamer_additional_gacha_rewards: [{ data: [], count: null }] })
    mockGetSupabaseAdmin.mockReturnValue(client as any)

    await DELETE(createDeleteRequest('deleteAll=true'))
    expect(getDb).not.toHaveBeenCalled()
  })
})
