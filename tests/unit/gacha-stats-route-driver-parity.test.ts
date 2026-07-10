/**
 * #663 (Batch A): GET /api/gacha-stats の postgrest 経路 / pg 経路の互換テスト。
 *
 * このルートで #663 が変更したのは streamers.id（配信者の自身のレコード）の
 * 単一行取得のみ。getGachaStats / getGachaCardOwnerStats は #573 で既に
 * 二重経路化・パリティテスト済み（dashboard-data-rpc-driver-parity.test.ts 等）の
 * ため、本テストではモジュールごと vi.mock してスタブ化し、streamers.id 取得の
 * 分岐と配線のみを検証する（責務の重複を避ける。gacha-history-routes-driver-parity
 * と同じ方針）。
 *
 * フラグ: 読み取り専用のため isPgReadEnabled() で分岐（DB_DRIVER=pg-read でも
 * pg 経路）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '@/app/api/gacha-stats/route'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { checkRateLimit } from '@/lib/rate-limit'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getGachaStats, getGachaCardOwnerStats } from '@/lib/dashboard-data'
import { getDb } from '@/lib/db/client'

vi.mock('@/lib/session')
vi.mock('@/lib/rate-limit')
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
const mockGetGachaStats = vi.mocked(getGachaStats)
const mockGetGachaCardOwnerStats = vi.mocked(getGachaCardOwnerStats)

const STREAMER_SESSION = {
  twitchUserId: 'streamer1',
  twitchUsername: 'streamer1',
  twitchDisplayName: 'Streamer 1',
  twitchProfileImageUrl: '',
  broadcasterType: 'affiliate' as const,
  expiresAt: Date.now() + 100000,
  version: 1,
}

const STATS_RESULT = {
  totalDraws: 5,
  cardStats: [],
  rarityStats: [],
  channelPointStats: { totalPoints: 0, ranking: [] },
} as any

function createRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/gacha-stats')
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  return new NextRequest(url)
}

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

function createDrizzleDbMock(config: {
  selects?: Array<{ rows?: Array<Record<string, unknown>>; error?: unknown }>
} = {}) {
  let selectIndex = 0
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
  }
  return { db }
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any)
}

describe('GET /api/gacha-stats（streamers.id 取得: 読み取り専用のため DB_DRIVER=pg-read でも pg 経路）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 30,
      remaining: 29,
      reset: Date.now() + 60000,
    })
    mockGetGachaStats.mockResolvedValue(STATS_RESULT)
    mockGetGachaCardOwnerStats.mockResolvedValue([] as any)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('両経路とも同じ streamerId で getGachaStats を呼び、同一レスポンスになる', async () => {
    mockGetSession.mockResolvedValue(STREAMER_SESSION)
    mockCanUseStreamerFeatures.mockReturnValue(true)

    vi.stubEnv('DB_DRIVER', undefined)
    mockGetSupabaseAdmin.mockReturnValue(createSupabaseClientMock({ id: 'streamer-id-1' }) as any)
    const postgrestRes = await GET(createRequest({ period: '7d' }))
    const postgrestBody = await postgrestRes.json()

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ selects: [{ rows: [{ id: 'streamer-id-1' }] }] })
    primePgDb(pg)
    const pgRes = await GET(createRequest({ period: '7d' }))
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)
    expect(mockGetGachaStats).toHaveBeenCalledWith('streamer-id-1', '7d')
  })

  it('period=byCard: 両経路とも同じ streamerId で getGachaCardOwnerStats を呼ぶ', async () => {
    mockGetSession.mockResolvedValue(STREAMER_SESSION)
    mockCanUseStreamerFeatures.mockReturnValue(true)

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ selects: [{ rows: [{ id: 'streamer-id-1' }] }] })
    primePgDb(pg)
    const res = await GET(createRequest({ period: 'byCard' }))

    expect(res.status).toBe(200)
    expect(mockGetGachaCardOwnerStats).toHaveBeenCalledWith('streamer-id-1')
    expect(mockGetGachaStats).not.toHaveBeenCalled()
  })

  it('配信者が存在しない（0行）: 両経路とも 404 STREAMER_NOT_FOUND', async () => {
    mockGetSession.mockResolvedValue(STREAMER_SESSION)
    mockCanUseStreamerFeatures.mockReturnValue(true)

    vi.stubEnv('DB_DRIVER', undefined)
    mockGetSupabaseAdmin.mockReturnValue(createSupabaseClientMock(null) as any)
    const postgrestRes = await GET(createRequest({ period: '7d' }))

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ selects: [{ rows: [] }] })
    primePgDb(pg)
    const pgRes = await GET(createRequest({ period: '7d' }))

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(404)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
    expect(mockGetGachaStats).not.toHaveBeenCalled()
  })

  it('未認証・非配信者・不正 period: フラグに依らず既存のバリデーション応答を維持する（getDb 不使用）', async () => {
    for (const driver of [undefined, 'pg-read']) {
      vi.stubEnv('DB_DRIVER', driver)

      mockGetSession.mockResolvedValue(null)
      expect((await GET(createRequest({ period: '7d' }))).status).toBe(401)

      mockGetSession.mockResolvedValue({ ...STREAMER_SESSION, broadcasterType: '' })
      mockCanUseStreamerFeatures.mockReturnValue(false)
      expect((await GET(createRequest({ period: '7d' }))).status).toBe(403)

      mockGetSession.mockResolvedValue(STREAMER_SESSION)
      mockCanUseStreamerFeatures.mockReturnValue(true)
      expect((await GET(createRequest({ period: 'bogus' }))).status).toBe(400)
    }
    expect(getDb).not.toHaveBeenCalled()
  })

  it('フラグ未設定時は getDb が一切呼ばれない（挙動不変の検証）', async () => {
    mockGetSession.mockResolvedValue(STREAMER_SESSION)
    mockCanUseStreamerFeatures.mockReturnValue(true)
    vi.stubEnv('DB_DRIVER', undefined)
    mockGetSupabaseAdmin.mockReturnValue(createSupabaseClientMock({ id: 'streamer-id-1' }) as any)

    await GET(createRequest({ period: '7d' }))
    expect(getDb).not.toHaveBeenCalled()
  })
})
