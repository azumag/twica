/**
 * #663: ガチャ履歴/統計ルート群の PlanetScale/Drizzle 回帰テスト
 *
 * 対象:
 *   - GET /api/gacha-history（streamer取得のみ対象。getGachaHistoryForStreamer等は
 *     #571で既にpg直結対応済みのためモックで切り離す）
 *   - DELETE /api/gacha-history/[id]（所有者確認の読み取り + DELETE）
 *   - GET /api/gacha-stats（streamer取得のみ対象。getGachaStats等は既にpg直結対応済み）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { checkRateLimit, getRateLimitIdentifier } from '@/lib/rate-limit'
import { validateCSRFToken } from '@/lib/csrf'
import { getDb } from '@/lib/db/client'
import { gachaHistory as gachaHistoryTable } from '@/lib/db/schema'
import { getGachaHistoryForStreamer, getGachaStats } from '@/lib/dashboard-data'

vi.mock('@/lib/session')
vi.mock('@/lib/csrf')
vi.mock('@/lib/rate-limit')
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/dashboard-data', () => ({
  getGachaHistoryForStreamer: vi.fn(),
  getGachaHistoryForUser: vi.fn(),
  getGachaUsersForStreamer: vi.fn(),
  getGachaStats: vi.fn(),
  getGachaCardOwnerStats: vi.fn(),
}))

const mockGetSession = vi.mocked(getSession)
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures)
const mockCheckRateLimit = vi.mocked(checkRateLimit)
const mockGetRateLimitIdentifier = vi.mocked(getRateLimitIdentifier)
const mockValidateCSRFToken = vi.mocked(validateCSRFToken)

const STREAMER_SESSION = {
  twitchUserId: 'streamer1',
  twitchUsername: 'streamer1',
  twitchDisplayName: 'Streamer 1',
  twitchProfileImageUrl: '',
  broadcasterType: 'affiliate',
  expiresAt: Date.now() + 100000,
  version: 1,
}

interface PgResponse {
  rows?: Array<Record<string, unknown>>
  error?: unknown
}

function createDrizzleDbMock(config: { selects?: PgResponse[]; deletes?: PgResponse[] } = {}) {
  let selectIndex = 0
  let deleteIndex = 0
  const deleteCalls: Array<{ table: unknown; where?: unknown }> = []

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
    delete: vi.fn((table: unknown) => {
      const responses = config.deletes ?? [{ rows: [] }]
      const response = responses[Math.min(deleteIndex, responses.length - 1)]
      deleteIndex += 1
      const call: { table: unknown; where?: unknown } = { table }
      deleteCalls.push(call)
      const resolve = () => (response.error ? Promise.reject(response.error) : Promise.resolve(response.rows ?? []))
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
  return { db, deleteCalls }
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any)
}

describe('ガチャ履歴/統計ルート: PlanetScale 経路 (#663)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue({ success: true, limit: 60, remaining: 59, reset: Date.now() + 60000 } as any)
    mockGetRateLimitIdentifier.mockResolvedValue('user:streamer1')
    mockValidateCSRFToken.mockResolvedValue({ valid: true } as any)
    mockGetSession.mockResolvedValue(STREAMER_SESSION as any)
    mockCanUseStreamerFeatures.mockReturnValue(true)
    vi.mocked(getGachaHistoryForStreamer).mockResolvedValue({ items: [], total: 0, page: 1, perPage: 20 } as any)
  })

  describe('GET /api/gacha-history', () => {
    it('streamerが見つかれば既存関数（getGachaHistoryForStreamer）に正しいidを渡す', async () => {
      const pg = createDrizzleDbMock({ selects: [{ rows: [{ id: 'streamer-id-1' }] }] })
      primePgDb(pg)

      const { GET } = await import('@/app/api/gacha-history/route')
      const url = new URL('http://localhost/api/gacha-history')
      const response = await GET(new NextRequest(url))

      expect(response.status).toBe(200)
      expect(getDb).toHaveBeenCalled()
      expect(getGachaHistoryForStreamer).toHaveBeenCalledWith('streamer-id-1', expect.any(Object))
    })

    it('streamerが見つからなければ404を返す', async () => {
      const pg = createDrizzleDbMock({ selects: [{ rows: [] }] })
      primePgDb(pg)

      const { GET } = await import('@/app/api/gacha-history/route')
      const url = new URL('http://localhost/api/gacha-history')
      const response = await GET(new NextRequest(url))

      expect(response.status).toBe(404)
    })
  })

  describe('GET /api/gacha-stats', () => {
    beforeEach(() => {
      vi.mocked(getGachaStats).mockResolvedValue({ totalDraws: 0 } as any)
    })

    it('streamerが見つかれば既存関数（getGachaStats）に正しいidを渡す', async () => {
      const pg = createDrizzleDbMock({ selects: [{ rows: [{ id: 'streamer-id-1' }] }] })
      primePgDb(pg)

      const { GET } = await import('@/app/api/gacha-stats/route')
      const url = new URL('http://localhost/api/gacha-stats')
      url.searchParams.set('period', '30d')
      const response = await GET(new NextRequest(url))

      expect(response.status).toBe(200)
      expect(getDb).toHaveBeenCalled()
      expect(getGachaStats).toHaveBeenCalledWith('streamer-id-1', '30d')
    })

    it('streamerが見つからなければ404を返す', async () => {
      const pg = createDrizzleDbMock({ selects: [{ rows: [] }] })
      primePgDb(pg)

      const { GET } = await import('@/app/api/gacha-stats/route')
      const url = new URL('http://localhost/api/gacha-stats')
      url.searchParams.set('period', '7d')
      const response = await GET(new NextRequest(url))

      expect(response.status).toBe(404)
    })
  })

  describe('DELETE /api/gacha-history/[id]', () => {
    const HISTORY_ID = '22222222-2222-4222-8222-222222222222'

    function createDeleteRequest(): NextRequest {
      return new NextRequest(`http://localhost/api/gacha-history/${HISTORY_ID}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'streamer1' }),
      })
    }

    it('所有者確認 + DELETE が正しいテーブル/条件で実行される', async () => {
      const pg = createDrizzleDbMock({
        selects: [{ rows: [{ user_twitch_id: 'streamer1' }] }],
        deletes: [{ rows: [] }],
      })
      primePgDb(pg)

      const { DELETE } = await import('@/app/api/gacha-history/[id]/route')
      const response = await DELETE(createDeleteRequest(), { params: Promise.resolve({ id: HISTORY_ID }) })
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body).toEqual({ success: true })
      expect(getDb).toHaveBeenCalled()
      expect(pg.deleteCalls[0].table).toBe(gachaHistoryTable)
    })

    it('所有者が一致しなければ403を返す', async () => {
      const pg = createDrizzleDbMock({ selects: [{ rows: [{ user_twitch_id: 'someone-else' }] }] })
      primePgDb(pg)

      const { DELETE } = await import('@/app/api/gacha-history/[id]/route')
      const response = await DELETE(createDeleteRequest(), { params: Promise.resolve({ id: HISTORY_ID }) })

      expect(response.status).toBe(403)
      expect(pg.deleteCalls).toHaveLength(0)
    })

    it('対象行が存在しなければ500（handleDatabaseError）を返す', async () => {
      const pg = createDrizzleDbMock({ selects: [{ rows: [] }] })
      primePgDb(pg)

      const { DELETE } = await import('@/app/api/gacha-history/[id]/route')
      const response = await DELETE(createDeleteRequest(), { params: Promise.resolve({ id: HISTORY_ID }) })

      expect(response.status).toBe(500)
    })
  })
})
