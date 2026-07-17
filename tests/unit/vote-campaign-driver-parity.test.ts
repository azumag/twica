/**
 * #663: 低頻度APIルート群のpg直結移行 — POST /api/storage-bonus/vote-campaign の
 * postgrest経路 / pg経路パリティテスト
 *
 * tests/unit/vote-campaign.test.ts が既存postgrest経路の詳細な挙動を検証済みの
 * ため、本ファイルは pg 経路固有の観点（正しいテーブル/値での INSERT・
 * 23505競合時のリトライ・接続断時の非冪等挙動）に絞る。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/storage-bonus/vote-campaign/route'
import { getSession } from '@/lib/session'
import { validateCSRFToken } from '@/lib/csrf'
import { getDb } from '@/lib/db/client'
import { VOTE_CAMPAIGN_CONFIG } from '@/lib/constants'
import { streamers as streamersTable, streamerStorageBonus as streamerStorageBonusTable } from '@/lib/db/schema'

vi.mock('@/lib/session')
vi.mock('@/lib/csrf')
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/sentry/error-handler')
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ success: true, limit: 5, remaining: 4, reset: Date.now() + 60000 }),
  rateLimits: { voteCampaign: {} },
  getRateLimitIdentifier: vi.fn().mockResolvedValue('user:user123'),
}))

const mockGetSession = vi.mocked(getSession)
const mockValidateCSRFToken = vi.mocked(validateCSRFToken)

function createRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/storage-bonus/vote-campaign', { method: 'POST' })
}

interface PgResponse {
  rows?: Array<Record<string, unknown>>
  error?: unknown
}

function createDrizzleDbMock(config: { selects?: PgResponse[]; inserts?: PgResponse[] } = {}) {
  let selectIndex = 0
  let insertIndex = 0
  const insertCalls: Array<{ table: unknown; values?: Record<string, unknown> }> = []

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
      const responses = config.inserts ?? [{ rows: [{ id: 'x' }] }]
      const response = responses[Math.min(insertIndex, responses.length - 1)]
      insertIndex += 1
      const call: { table: unknown; values?: Record<string, unknown> } = { table }
      insertCalls.push(call)
      const resolve = () => (response.error ? Promise.reject(response.error) : Promise.resolve(response.rows ?? []))
      const builder: any = {
        values: vi.fn((values: Record<string, unknown>) => {
          call.values = values
          return builder
        }),
        returning: vi.fn(() => resolve()),
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

describe('POST /api/storage-bonus/vote-campaign: postgrest / pg 経路の互換 (#663)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSession.mockResolvedValue({
      twitchUserId: 'user123',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/avatar.jpg',
      broadcasterType: '',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: 1,
    } as any)
    mockValidateCSRFToken.mockResolvedValue({ valid: true } as any)

    vi.useFakeTimers()
    const campaignMidpoint = new Date(
      (VOTE_CAMPAIGN_CONFIG.START_DATE.getTime() + VOTE_CAMPAIGN_CONFIG.END_DATE.getTime()) / 2
    )
    vi.setSystemTime(campaignMidpoint)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('フラグ未設定時は getDb が呼ばれない（挙動不変の検証）', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({
      from: vi.fn(() => ({
        select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 's1' }, error: null }) })) })),
        insert: vi.fn(() => Promise.resolve({ data: null, error: null })),
      })),
    } as any)

    const response = await POST(createRequest())
    expect(response.status).toBe(200)
    expect(getDb).not.toHaveBeenCalled()
  })

  it('DB_DRIVER=pg: 既存streamerがあれば新規INSERTせず、正しいstreamer_idでボーナスがINSERTされる', async () => {
    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({ selects: [{ rows: [{ id: 'existing-streamer-uuid' }] }] })
    primePgDb(pg)

    const response = await POST(createRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    expect(pg.insertCalls).toHaveLength(1)
    expect(pg.insertCalls[0].table).toBe(streamerStorageBonusTable)
    expect(pg.insertCalls[0].values).toMatchObject({ streamer_id: 'existing-streamer-uuid' })
  })

  it('DB_DRIVER=pg: 既存streamerが無ければ新規INSERTしてからボーナスをINSERTする', async () => {
    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [] }],
      inserts: [{ rows: [{ id: 'new-streamer-uuid' }] }, { rows: [{ id: 'bonus-1' }] }],
    })
    primePgDb(pg)

    const response = await POST(createRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    expect(pg.insertCalls[0].table).toBe(streamersTable)
    expect(pg.insertCalls[0].values).toMatchObject({ twitch_user_id: 'user123' })
    expect(pg.insertCalls[1].table).toBe(streamerStorageBonusTable)
    expect(pg.insertCalls[1].values).toMatchObject({ streamer_id: 'new-streamer-uuid' })
  })

  it('DB_DRIVER=pg: ボーナスINSERTが23505で失敗した場合は409（postgrest経路と同じ外部挙動）', async () => {
    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [{ id: 'existing-streamer-uuid' }] }],
      inserts: [{ error: { code: '23505', message: 'duplicate key' } }],
    })
    primePgDb(pg)

    const response = await POST(createRequest())
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body.error).toBe('このキャンペーンは既に適用済みです')
  })

  it('DB_DRIVER=pg: streamer作成が23505で失敗した場合はリトライして既存行を再取得する（レースコンディション対応）', async () => {
    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [] }, { rows: [{ id: 'race-streamer-uuid' }] }],
      inserts: [{ error: { code: '23505', message: 'duplicate key' } }, { rows: [{ id: 'bonus-1' }] }],
    })
    primePgDb(pg)

    const response = await POST(createRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    // streamer_storage_bonus への INSERT はリトライで取得した race-streamer-uuid を使う
    expect(pg.insertCalls[pg.insertCalls.length - 1].values).toMatchObject({ streamer_id: 'race-streamer-uuid' })
  })

  // 2026-07 Fable厳格レビュー指摘(高2)の回帰テスト: Drizzle は postgres.js の
  // エラーを DrizzleQueryError で `{ query, params, cause }` に1段ラップする。
  // insertStorageBonusPg / insertStreamerPg は以前トップレベルの code だけを
  // 見ていたため、ラップされた 23505 は常に code: undefined へ落ち、
  // 409（既に適用済み）判定が働かず 500 になっていた。
  it('DB_DRIVER=pg: ボーナスINSERTが23505で失敗した場合（Drizzleラップ形状）でも409になる', async () => {
    vi.stubEnv('DB_DRIVER', 'pg')
    const wrapped23505 = Object.assign(new Error('Failed query: insert into streamer_storage_bonus ...'), {
      query: 'insert into streamer_storage_bonus ...',
      params: [],
      cause: Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }),
    })
    const pg = createDrizzleDbMock({
      selects: [{ rows: [{ id: 'existing-streamer-uuid' }] }],
      inserts: [{ error: wrapped23505 }],
    })
    primePgDb(pg)

    const response = await POST(createRequest())
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body.error).toBe('このキャンペーンは既に適用済みです')
  })

  it('DB_DRIVER=pg: streamer作成が23505で失敗した場合（Drizzleラップ形状）でもリトライして既存行を再取得する', async () => {
    vi.stubEnv('DB_DRIVER', 'pg')
    const wrapped23505 = Object.assign(new Error('Failed query: insert into streamers ...'), {
      query: 'insert into streamers ...',
      params: [],
      cause: Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }),
    })
    const pg = createDrizzleDbMock({
      selects: [{ rows: [] }, { rows: [{ id: 'race-streamer-uuid' }] }],
      inserts: [{ error: wrapped23505 }, { rows: [{ id: 'bonus-1' }] }],
    })
    primePgDb(pg)

    const response = await POST(createRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    expect(pg.insertCalls[pg.insertCalls.length - 1].values).toMatchObject({ streamer_id: 'race-streamer-uuid' })
  })

  it('DB_DRIVER=pg: streamer_storage_bonus の INSERT は接続断でもリトライされない（非冪等・二重付与防止）', async () => {
    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [{ id: 'existing-streamer-uuid' }] }],
      inserts: [{ error: Object.assign(new Error('connection closed'), { code: 'CONNECTION_CLOSED' }) }],
    })
    primePgDb(pg)

    const response = await POST(createRequest())
    // 接続断はリトライされず、そのまま500エラーとしてhandleApiErrorに渡る
    expect(response.status).toBe(500)
    // insert が呼ばれたのは1回のみ（リトライされていない）
    expect(pg.insertCalls).toHaveLength(1)
  })
})
