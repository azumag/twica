// Issue #641: 連ガチャ上限を10枚から15枚に引き上げ。
// raid-gacha ルート(streamers.raid_gacha_draw_count)には元々このバリデーションの
// 境界値テストが存在しなかった(実装プランで既存カバレッジの欠落として指摘済み)ため、
// additional-rewards-api.test.ts の起こしパターンに倣って新規に追加する。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/streamer/raid-gacha/route'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { checkRateLimit } from '@/lib/rate-limit'
import { validateCSRFToken } from '@/lib/csrf'
import { validateContentType } from '@/lib/request-validation'
import { getDb } from '@/lib/db/client'

vi.mock('@/lib/session')
vi.mock('@/lib/rate-limit')
vi.mock('@/lib/csrf')
vi.mock('@/lib/request-validation')

const mockGetSession = vi.mocked(getSession)
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures)
const mockCheckRateLimit = vi.mocked(checkRateLimit)
const mockValidateCSRFToken = vi.mocked(validateCSRFToken)
const mockValidateContentType = vi.mocked(validateContentType)

function postRequest(drawCount: unknown) {
  return new NextRequest('http://localhost/api/streamer/raid-gacha', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ drawCount }),
  })
}

/**
 * POSTの所有権SELECTとUPDATE ... RETURNINGを順に再現するPlanetScale fixture。
 * 境界値テストでも成功ケースは認可を通過した実際のroute形状で永続化を確認する。
 */
function primeRaidGachaDb(drawCount: number) {
  const selectBuilder: any = {}
  selectBuilder.from = vi.fn(() => selectBuilder)
  selectBuilder.where = vi.fn(() => selectBuilder)
  selectBuilder.limit = vi.fn(() => selectBuilder)
  selectBuilder.then = (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve([{
      id: 'streamer-1',
      raid_gacha_active_until: null,
      raid_gacha_draw_count: 10,
    }]).then(resolve, reject)

  const updateCall: { values?: unknown } = {}
  const updateBuilder: any = {}
  updateBuilder.set = vi.fn((values: unknown) => {
    updateCall.values = values
    return updateBuilder
  })
  updateBuilder.where = vi.fn(() => updateBuilder)
  updateBuilder.returning = vi.fn(() => updateBuilder)
  updateBuilder.then = (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve([{
      raid_gacha_active_until: null,
      raid_gacha_draw_count: drawCount,
    }]).then(resolve, reject)

  vi.mocked(getDb).mockResolvedValue({
    db: {
      select: vi.fn(() => selectBuilder),
      update: vi.fn(() => updateBuilder),
    } as never,
    sql: {} as never,
  })
  return updateCall
}

describe('/api/streamer/raid-gacha drawCount boundary validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSession.mockResolvedValue({
      twitchUserId: 'streamer-twitch-1',
      twitchUsername: 'streamer',
      twitchDisplayName: 'Streamer',
      twitchProfileImageUrl: 'https://example.com/avatar.png',
      broadcasterType: 'affiliate',
      expiresAt: Date.now() + 60_000,
      version: 1,
    })
    mockCanUseStreamerFeatures.mockReturnValue(true)
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Date.now() + 60_000,
    })
    mockValidateCSRFToken.mockResolvedValue({ valid: true })
    mockValidateContentType.mockReturnValue(null)
  })

  it('rejects a drawCount above the new upper bound (16 > 15) with a 400 and updated error message', async () => {
    const response = await POST(postRequest(16))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'drawCount must be an integer between 0 and 15',
    })
  })

  it('rejects a negative drawCount with a 400', async () => {
    const response = await POST(postRequest(-1))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'drawCount must be an integer between 0 and 15',
    })
  })

  it('accepts the new upper boundary value (15) and persists it', async () => {
    const updateCall = primeRaidGachaDb(15)

    const response = await POST(postRequest(15))

    expect(response.status).toBe(200)
    expect(updateCall.values).toEqual({ raid_gacha_draw_count: 15 })
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ success: true, drawCount: 15 })
    )
  })

  it('rejects the old upper boundary plus one (11) only if it exceeds the configured limit (non-regression: 11-15 now valid)', async () => {
    const updateCall = primeRaidGachaDb(11)

    // 11 was rejected under the old (<=10) limit; issue #641 raises the cap to 15,
    // so this value (previously invalid) must now be accepted end to end.
    const response = await POST(postRequest(11))

    expect(response.status).toBe(200)
    expect(updateCall.values).toEqual({ raid_gacha_draw_count: 11 })
  })
})
