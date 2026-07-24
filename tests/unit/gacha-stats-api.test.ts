/**
 * GET /api/gacha-stats のHTTP契約を検証する。
 *
 * 統計のSQL/RPC変換は dashboard-data-rpc-driver-parity.test.ts の責務とし、
 * ここでは route 固有の認証・権限・レート制限・入力検証・Drizzle による
 * 配信者解決・サービス関数への引数伝播を分離して確認する。この境界分離により、
 * PostgREST のレスポンス形状を route テストへ再導入せずに済む。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '@/app/api/gacha-stats/route'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { checkRateLimit } from '@/lib/rate-limit'
import { getDb } from '@/lib/db/client'
import { getGachaCardOwnerStats, getGachaStats } from '@/lib/dashboard-data'

vi.mock('@/lib/session')
vi.mock('@/lib/rate-limit')
vi.mock('@/lib/dashboard-data', () => ({
  getGachaStats: vi.fn(),
  getGachaCardOwnerStats: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn(),
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}))

const SESSION = {
  twitchUserId: 'streamer-twitch-id',
  twitchUsername: 'streamer',
  twitchDisplayName: 'Streamer',
  twitchProfileImageUrl: '',
  broadcasterType: 'affiliate',
  expiresAt: Date.now() + 100_000,
  version: 1 as const,
}

function createRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost/api/gacha-stats')
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  return new NextRequest(url)
}

/**
 * route が必要とする select(...).from(...).where(...).limit(1) だけを持つ
 * Drizzle テストダブル。最終 builder を thenable にし、実クエリと同じ await
 * インターフェースを保つことで route の実装詳細に不要な依存を増やさない。
 */
function primeStreamerLookup(row: { id: string } | null) {
  const builder: any = {
    from: vi.fn(() => builder),
    where: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(row ? [row] : []).then(resolve, reject),
  }
  const db = { select: vi.fn(() => builder) }
  vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any)
  return { db, builder }
}

describe('GET /api/gacha-stats', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getSession).mockResolvedValue(SESSION)
    vi.mocked(canUseStreamerFeatures).mockReturnValue(true)
    vi.mocked(checkRateLimit).mockResolvedValue({
      success: true,
      limit: 30,
      remaining: 29,
      reset: Date.now() + 60_000,
    })
    primeStreamerLookup({ id: 'streamer-id-1' })
  })

  it('未認証なら 401 を返しDBへ接続しない', async () => {
    vi.mocked(getSession).mockResolvedValue(null)

    const response = await GET(createRequest({ period: '7d' }))

    expect(response.status).toBe(401)
    expect(getDb).not.toHaveBeenCalled()
  })

  it('配信者機能を使えないユーザーなら 403 を返す', async () => {
    vi.mocked(canUseStreamerFeatures).mockReturnValue(false)

    const response = await GET(createRequest({ period: '7d' }))

    expect(response.status).toBe(403)
    expect(getDb).not.toHaveBeenCalled()
  })

  it('レート制限超過なら 429 と制限ヘッダーを返す', async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      success: false,
      limit: 30,
      remaining: 0,
      reset: 123_456,
    })

    const response = await GET(createRequest({ period: '7d' }))

    expect(response.status).toBe(429)
    expect(response.headers.get('X-RateLimit-Limit')).toBe('30')
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('0')
    expect(response.headers.get('X-RateLimit-Reset')).toBe('123456')
    expect(getDb).not.toHaveBeenCalled()
  })

  it.each([undefined, 'invalid', '1d'])(
    'period=%s は 400 を返す',
    async (period) => {
      const response = await GET(createRequest(period ? { period } : {}))
      expect(response.status).toBe(400)
      expect(getDb).not.toHaveBeenCalled()
    }
  )

  it('Drizzle で配信者を解決できなければ 404 を返す', async () => {
    primeStreamerLookup(null)

    const response = await GET(createRequest({ period: '7d' }))

    expect(response.status).toBe(404)
    expect(getGachaStats).not.toHaveBeenCalled()
  })

  it.each(['7d', '30d'] as const)(
    '%s の統計を配信者ID付きで取得し、そのままJSON化する',
    async (period) => {
      const stats = {
        totalDraws: period === '7d' ? 7 : 30,
        cardStats: [],
        rarityStats: [],
        channelPointStats: { totalPoints: 250, ranking: [] },
      }
      vi.mocked(getGachaStats).mockResolvedValue(stats)

      const response = await GET(createRequest({ period }))

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(stats)
      expect(getGachaStats).toHaveBeenCalledWith('streamer-id-1', period)
      expect(getGachaCardOwnerStats).not.toHaveBeenCalled()
    }
  )

  it('byCard は所有者統計を選び、通常の期間統計を呼ばない', async () => {
    const ownerStats = {
      cardStats: [
        {
          cardId: 'card-1',
          cardName: 'Card One',
          rarity: 'rare',
          imageUrl: null,
          ownerCount: 1,
          owners: [
            {
              userTwitchId: 'viewer-1',
              username: 'viewer',
              displayName: 'Viewer',
              ownedCount: 2,
              lastObtainedAt: '2026-01-01T00:00:00Z',
            },
          ],
        },
      ],
    }
    vi.mocked(getGachaCardOwnerStats).mockResolvedValue(ownerStats)

    const response = await GET(createRequest({ period: 'byCard' }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(ownerStats)
    expect(getGachaCardOwnerStats).toHaveBeenCalledWith('streamer-id-1')
    expect(getGachaStats).not.toHaveBeenCalled()
  })

  it('統計サービスの例外は共通APIエラーハンドラー経由で 500 にする', async () => {
    // 共通エラーハンドラーが本番ログへ記録する console.error は期待された副作用。
    // テスト出力を汚さず、ログ経路自体が呼ばれたことは明示的に検証する。
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(getGachaStats).mockRejectedValue(new Error('database unavailable'))

    const response = await GET(createRequest({ period: '7d' }))

    expect(response.status).toBe(500)
    expect(consoleError).toHaveBeenCalledWith(
      '[ERROR] Fetching gacha stats:',
      expect.objectContaining({ message: 'database unavailable' })
    )
    consoleError.mockRestore()
  })
})
