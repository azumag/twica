/**
 * GET /api/streamer-ranking の HTTP 契約 (Issue #742 子B) を検証する。
 *
 * 認可（401/403）、レート制限（429 + ヘッダ）、自 streamer 解決（404）、
 * DB 関数未適用のデプロイ窓（503）、サービス例外（500）、および
 * 「route が応答へ何も付加しない（匿名化境界は DB 関数にある）」ことを確認する。
 * ランキングの内容そのものは DB 側 fixture
 * (tests/fixtures/streamer-ranking-read-postgres.sql) の責務とする。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '@/app/api/streamer-ranking/route'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { checkRateLimit } from '@/lib/rate-limit'
import { getStreamerIdByTwitchUserId } from '@/lib/user-data'
import { getStreamerRanking } from '@/lib/services/streamer-ranking'

vi.mock('@/lib/session')
vi.mock('@/lib/rate-limit')
vi.mock('@/lib/user-data', () => ({
  getStreamerIdByTwitchUserId: vi.fn(),
}))
vi.mock('@/lib/services/streamer-ranking', () => ({
  getStreamerRanking: vi.fn(),
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

const RESPONSE = {
  schemaVersion: 1 as const,
  computedAt: '2026-10-07T11:00:00.000Z',
  rankings: [
    {
      metric: 'draws' as const,
      period: 'total' as const,
      participantCount: 13,
      insufficientData: false,
      self: { value: 50, rank: 1, percentile: 100 },
      top: [{ rank: 1, value: 50, isSelf: true }],
      neighbors: [],
    },
  ],
}

function createRequest(): NextRequest {
  return new NextRequest('http://localhost/api/streamer-ranking')
}

describe('GET /api/streamer-ranking (Issue #742)', () => {
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
    vi.mocked(getStreamerIdByTwitchUserId).mockResolvedValue({ id: 'streamer-id-1' })
    vi.mocked(getStreamerRanking).mockResolvedValue({
      available: true,
      response: RESPONSE,
    })
  })

  it('未認証なら 401 を返しDBへ到達しない', async () => {
    vi.mocked(getSession).mockResolvedValue(null)

    const response = await GET(createRequest())

    expect(response.status).toBe(401)
    expect(getStreamerIdByTwitchUserId).not.toHaveBeenCalled()
    expect(getStreamerRanking).not.toHaveBeenCalled()
  })

  it('配信者機能を使えないユーザーなら 403 を返す', async () => {
    vi.mocked(canUseStreamerFeatures).mockReturnValue(false)

    const response = await GET(createRequest())

    expect(response.status).toBe(403)
    expect(getStreamerRanking).not.toHaveBeenCalled()
  })

  it('レート制限超過なら 429 と制限ヘッダーを返す', async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      success: false,
      limit: 30,
      remaining: 0,
      reset: 123_456,
    })

    const response = await GET(createRequest())

    expect(response.status).toBe(429)
    expect(response.headers.get('X-RateLimit-Limit')).toBe('30')
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('0')
    expect(response.headers.get('X-RateLimit-Reset')).toBe('123456')
    expect(getStreamerRanking).not.toHaveBeenCalled()
  })

  it('配信者を解決できなければ 404 を返しランキングを取得しない', async () => {
    vi.mocked(getStreamerIdByTwitchUserId).mockResolvedValue(null)

    const response = await GET(createRequest())

    expect(response.status).toBe(404)
    expect(getStreamerRanking).not.toHaveBeenCalled()
  })

  it('自分の streamerId でサービスを呼び、応答をそのまま JSON 化する', async () => {
    const response = await GET(createRequest())

    expect(response.status).toBe(200)
    // route が応答へ識別子や追加フィールドを足していないこと（匿名化境界は DB 関数側）
    expect(await response.json()).toEqual(RESPONSE)
    expect(getStreamerRanking).toHaveBeenCalledWith('streamer-id-1')
  })

  it('クエリパラメータで他人の streamerId を指定できず、常にセッションの配信者を使う', async () => {
    // 任意の streamer_id を差し込める脱匿名化オラクルを作らないことの確認。
    const response = await GET(
      new NextRequest(
        'http://localhost/api/streamer-ranking?streamerId=other-streamer-id&streamer_id=other'
      )
    )

    expect(response.status).toBe(200)
    expect(getStreamerRanking).toHaveBeenCalledTimes(1)
    expect(getStreamerRanking).toHaveBeenCalledWith('streamer-id-1')
  })

  it.each(['42883', '42P01'] as const)(
    'DB 関数/テーブル未適用（%s）は 503 を返す',
    async (code) => {
      vi.mocked(getStreamerRanking).mockResolvedValue({ available: false, code })

      const response = await GET(createRequest())

      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({
        error: 'Streamer ranking is not available yet. Please try again shortly.',
      })
    }
  )

  it('サービスの例外は共通APIエラーハンドラー経由で 500 にする', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(getStreamerRanking).mockRejectedValue(new Error('database unavailable'))

    const response = await GET(createRequest())

    expect(response.status).toBe(500)
    expect(consoleError).toHaveBeenCalledWith(
      '[ERROR] Fetching streamer ranking:',
      expect.objectContaining({ message: 'database unavailable' })
    )
    consoleError.mockRestore()
  })
})
