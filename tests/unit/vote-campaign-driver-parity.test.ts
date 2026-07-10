/**
 * #663: /api/storage-bonus/vote-campaign (POST) の postgrest 経路 / pg 経路の互換テスト
 *
 * tests/unit/vote-campaign.test.ts のモック方法（session / csrf / rate-limit）と、
 * support-inquiries-api-driver-parity.test.ts の流儀（同一 fixture を両経路に与えて
 * HTTP ステータス・body・副作用（insert に渡る値）を突き合わせる）を組み合わせる。
 *
 * streamers の読み取り + streamers/streamer_storage_bonus への INSERT が混在するため
 * isPgWriteEnabled() で関数全体が分岐する（DB_DRIVER=pg のときのみ pg 経路）。
 * レースコンディション（23505 での再取得）・ボーナス重複適用（23505 → 409）の
 * エラーコード分岐パリティも検証する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { POST } from '@/app/api/storage-bonus/vote-campaign/route'
import { getSession } from '@/lib/session'
import { validateCSRFToken } from '@/lib/csrf'
import { checkRateLimit } from '@/lib/rate-limit'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getDb } from '@/lib/db/client'
import { VOTE_CAMPAIGN_CONFIG } from '@/lib/constants'
import {
  streamers as streamersTable,
  streamerStorageBonus as streamerStorageBonusTable,
} from '@/lib/db/schema'

vi.mock('@/lib/session')
vi.mock('@/lib/csrf')
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn(),
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(),
  rateLimits: { voteCampaign: {} },
  getRateLimitIdentifier: vi.fn().mockResolvedValue('user:user-1'),
}))

const mockGetSession = vi.mocked(getSession)
const mockValidateCSRFToken = vi.mocked(validateCSRFToken)
const mockCheckRateLimit = vi.mocked(checkRateLimit)

function createRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/storage-bonus/vote-campaign', {
    method: 'POST',
  })
}

function allowRateLimit() {
  mockCheckRateLimit.mockResolvedValue({
    success: true,
    limit: 5,
    remaining: 4,
    reset: Date.now() + 60000,
  })
}

// ---------------------------------------------------------------------------
// postgrest 経路のモック: streamers 検索 → (必要なら) streamers INSERT →
// streamer_storage_bonus INSERT、の順に呼ばれる from() 呼び出しキュー
// ---------------------------------------------------------------------------

interface PostgrestResponse {
  data?: unknown
  error?: unknown
}

function createSupabaseClientMock(responses: PostgrestResponse[]) {
  let index = 0
  const insertCalls: Array<{ table: string; values: unknown }> = []
  const from = vi.fn((table: string) => {
    const response = responses[Math.min(index, responses.length - 1)]
    index += 1
    const resolved = { data: response.data ?? null, error: response.error ?? null }
    const builder: any = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      maybeSingle: vi.fn(() => Promise.resolve(resolved)),
      single: vi.fn(() => Promise.resolve(resolved)),
      insert: vi.fn((values: unknown) => {
        insertCalls.push({ table, values })
        return builder
      }),
      then: (onFulfilled: any, onRejected: any) => Promise.resolve(resolved).then(onFulfilled, onRejected),
    }
    return builder
  })
  return { from, insertCalls }
}

// ---------------------------------------------------------------------------
// pg 経路のモック: db.select(...).from(table).where().limit(1)（thenable）と
// db.insert(table).values(...).returning(...) / .values(...)（thenable、insert bonus は
// returning を呼ばない実装のため values() 自体が thenable を返す）
// ---------------------------------------------------------------------------

interface PgSelectResponse {
  rows?: Array<Record<string, unknown>>
  error?: unknown
}

interface PgInsertResponse {
  rows?: Array<Record<string, unknown>>
  error?: unknown
}

function createDrizzleDbMock(config: {
  selects?: PgSelectResponse[]
  inserts?: PgInsertResponse[]
} = {}) {
  let selectIndex = 0
  let insertIndex = 0
  const selectCalls: Array<{ table?: unknown; where?: unknown }> = []
  const insertCalls: Array<{ table: unknown; values?: Record<string, unknown> }> = []

  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      const responses = config.selects ?? [{ rows: [] }]
      const response = responses[Math.min(selectIndex, responses.length - 1)]
      selectIndex += 1
      const call: { table?: unknown; where?: unknown } = {}
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
        limit: vi.fn(() => builder),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
    insert: vi.fn((table: unknown) => {
      const responses = config.inserts ?? [{ rows: [{ id: 'unused' }] }]
      const response = responses[Math.min(insertIndex, responses.length - 1)]
      insertIndex += 1
      const call: { table: unknown; values?: Record<string, unknown> } = { table }
      insertCalls.push(call)
      const resolve = () =>
        response.error ? Promise.reject(response.error) : Promise.resolve(response.rows ?? [])
      const builder: any = {
        values: vi.fn((values: Record<string, unknown>) => {
          call.values = values
          return {
            ...builder,
            returning: vi.fn(() => resolve()),
            then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
          }
        }),
      }
      return builder
    }),
  }
  return { db, selectCalls, insertCalls }
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any)
}

describe('/api/storage-bonus/vote-campaign: postgrest / pg 経路の互換 (#663)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    allowRateLimit()
    mockValidateCSRFToken.mockResolvedValue({ valid: true })
    mockGetSession.mockResolvedValue({
      twitchUserId: 'user-1',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: null,
      broadcasterType: '',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: 1,
    } as any)

    // キャンペーン期間内の固定時刻（既存 vote-campaign.test.ts と同じ方式）
    vi.useFakeTimers()
    const campaignMidpoint = new Date(
      (VOTE_CAMPAIGN_CONFIG.START_DATE.getTime() + VOTE_CAMPAIGN_CONFIG.END_DATE.getTime()) / 2
    )
    vi.setSystemTime(campaignMidpoint)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('既存 streamer あり: 両経路とも 200 + { success: true }、bonus INSERT の values が一致する', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock([
      { data: { id: 'streamer-1' } }, // streamers select
      { data: null }, // streamer_storage_bonus insert（成功時は error なし）
    ])
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestRes = await POST(createRequest())
    const postgrestBody = await postgrestRes.json()

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [{ id: 'streamer-1' }] }],
      inserts: [{ rows: [] }],
    })
    primePgDb(pg)
    const pgRes = await POST(createRequest())
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)
    expect(pgBody).toEqual({ success: true })

    // streamers 検索の where 条件パリティ
    expect(pg.selectCalls[0].table).toBe(streamersTable)
    expect(pg.selectCalls[0].where).toEqual(eq(streamersTable.twitch_user_id, 'user-1'))

    // bonus INSERT の values パリティ（既存 streamer の id をそのまま使う）
    expect(pg.insertCalls).toHaveLength(1)
    expect(pg.insertCalls[0].table).toBe(streamerStorageBonusTable)
    expect(pg.insertCalls[0].values).toEqual({
      streamer_id: 'streamer-1',
      amount_mb: VOTE_CAMPAIGN_CONFIG.BONUS_MB,
      type: VOTE_CAMPAIGN_CONFIG.TYPE,
      memo: VOTE_CAMPAIGN_CONFIG.MEMO,
    })
    expect(pg.insertCalls[0].values).toEqual(client.insertCalls[0].values)
  })

  it('streamer 不在: 新規作成してから bonus を INSERT し、両経路の結果が一致する', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock([
      { data: null }, // streamers select: 不在
      { data: { id: 'new-streamer-id' } }, // streamers insert
      { data: null }, // streamer_storage_bonus insert
    ])
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestRes = await POST(createRequest())

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [] }],
      inserts: [{ rows: [{ id: 'new-streamer-id' }] }, { rows: [] }],
    })
    primePgDb(pg)
    const pgRes = await POST(createRequest())

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())

    // 1件目: streamers への新規 INSERT（最小限の情報のみ）
    expect(pg.insertCalls[0].table).toBe(streamersTable)
    expect(pg.insertCalls[0].values).toEqual({
      twitch_user_id: 'user-1',
      twitch_username: 'testuser',
      twitch_display_name: 'Test User',
    })
    // 2件目: 新規作成した streamer_id で bonus INSERT
    expect(pg.insertCalls[1].table).toBe(streamerStorageBonusTable)
    expect(pg.insertCalls[1].values).toMatchObject({ streamer_id: 'new-streamer-id' })
  })

  it('streamer INSERT がレース(23505)で失敗: 再取得したstreamerでbonus INSERTを続行する', async () => {
    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      // 1回目: 不在 → INSERT 失敗(23505) → 2回目 select で再取得成功
      selects: [{ rows: [] }, { rows: [{ id: 'race-winner-id' }] }],
      inserts: [{ error: { code: '23505', message: 'duplicate key' } }, { rows: [] }],
    })
    primePgDb(pg)

    const res = await POST(createRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ success: true })
    expect(pg.insertCalls[1].values).toMatchObject({ streamer_id: 'race-winner-id' })
  })

  it('bonus INSERT が UNIQUE 制約違反(23505): 両経路とも 409（適用済み）を返す', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock([
      { data: { id: 'streamer-1' } },
      { error: { code: '23505', message: 'duplicate key' } },
    ])
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestRes = await POST(createRequest())

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [{ id: 'streamer-1' }] }],
      inserts: [{ error: { code: '23505', message: 'duplicate key' } }],
    })
    primePgDb(pg)
    const pgRes = await POST(createRequest())

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(409)
    const [pgBody, postgrestBody] = await Promise.all([pgRes.json(), postgrestRes.json()])
    expect(pgBody).toEqual(postgrestBody)
    expect(pgBody).toEqual({ error: 'このキャンペーンは既に適用済みです' })
  })

  it('bonus INSERT がその他のエラー: 両経路とも 500（handleApiError）を返す', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock([
      { data: { id: 'streamer-1' } },
      { error: { code: '42601', message: 'syntax error' } },
    ])
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestRes = await POST(createRequest())

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [{ id: 'streamer-1' }] }],
      inserts: [{ error: { code: '42601', message: 'syntax error' } }],
    })
    primePgDb(pg)
    const pgRes = await POST(createRequest())

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(500)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
  })

  it('CSRF 無効: 両経路とも 403（フラグに依らず同一。getDb は呼ばれない）', async () => {
    mockValidateCSRFToken.mockResolvedValue({ valid: false })
    for (const driver of [undefined, 'pg']) {
      vi.stubEnv('DB_DRIVER', driver as string)
      const res = await POST(createRequest())
      expect(res.status).toBe(403)
    }
    expect(getDb).not.toHaveBeenCalled()
  })

  it('未認証: 両経路とも 401', async () => {
    mockGetSession.mockResolvedValue(null)
    for (const driver of [undefined, 'pg']) {
      vi.stubEnv('DB_DRIVER', driver as string)
      const res = await POST(createRequest())
      expect(res.status).toBe(401)
    }
    expect(getDb).not.toHaveBeenCalled()
  })

  it('キャンペーン期間外（サーバー時刻判定）: 両経路とも 400（DB アクセス前に弾かれる）', async () => {
    vi.setSystemTime(new Date(VOTE_CAMPAIGN_CONFIG.END_DATE.getTime() + 1000))
    for (const driver of [undefined, 'pg']) {
      vi.stubEnv('DB_DRIVER', driver as string)
      const res = await POST(createRequest())
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'キャンペーン期間外です' })
    }
    expect(getDb).not.toHaveBeenCalled()
  })

  it('DB_DRIVER=pg-read では書き込みハンドラのため postgrest 経路のまま（getDb 不使用）', async () => {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const client = createSupabaseClientMock([
      { data: { id: 'streamer-1' } },
      { data: null },
    ])
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)

    const res = await POST(createRequest())
    expect(res.status).toBe(200)
    expect(getDb).not.toHaveBeenCalled()
  })

  it('フラグ未設定時は getDb が一切呼ばれない（挙動不変の検証）', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock([
      { data: { id: 'streamer-1' } },
      { data: null },
    ])
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)

    await POST(createRequest())
    expect(getDb).not.toHaveBeenCalled()
  })
})
