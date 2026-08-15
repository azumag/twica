import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { getDb } from '@/lib/db/client'
import { __resetTwitchAppTokenForTests } from '@/lib/twitch/app-token'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/session', () => ({
  getSession: vi.fn(),
  canUseStreamerFeatures: vi.fn(),
}))
vi.mock('@/lib/rate-limit', () => ({
  getRateLimitIdentifier: vi.fn().mockResolvedValue('user:test'),
  checkRateLimit: vi.fn(),
  rateLimits: { twitchRewardsGet: { windowMs: 60000, max: 30 } },
}))
vi.mock('@/lib/twitch/token-manager', () => ({
  hasScope: vi.fn(),
  getTwitchAccessToken: vi.fn(),
  // Issue #653/#670: route handlerのcatchが常に呼ぶため固定モックにも必要。
  twitchTokenErrorReportContext: vi.fn().mockReturnValue(undefined),
}))
vi.mock('@/lib/db/client', () => ({ getDb: vi.fn() }))
// #788: GET ハンドラは早期returnも含め常に getChannelPointsAccessState を呼ぶため、
// このモジュールをモックしないと未モックの実装（users テーブルへの
// 実際の PlanetScale/Drizzle クエリ）が走ってしまい、このファイルが検証したい
// hasRequiredScope/rewards/diagnostics周りの挙動と無関係な失敗を招く。
// デフォルトは capability: 'unknown' とし、capability/temporarilyUnavailable の
// 挙動そのものを検証するテストではケースごとに mockResolvedValueOnce で上書きする。
vi.mock('@/lib/twitch/channel-points-access', () => ({
  getChannelPointsAccessState: vi.fn().mockResolvedValue({
    capability: 'unknown',
    checkedAt: null,
    enabled: false,
  }),
  recordChannelPointsApiFailure: vi.fn().mockResolvedValue(undefined),
  persistChannelPointsCapability: vi.fn().mockResolvedValue(undefined),
}))

const session = {
  twitchUserId: 'streamer-1',
  twitchUsername: 'streamer',
  twitchDisplayName: 'Streamer',
  twitchProfileImageUrl: null,
  broadcasterType: 'affiliate',
  expiresAt: Date.now() + 10000,
  version: 1,
}

function request(url = 'http://localhost:3000/api/twitch/channel-point-bootstrap') {
  return new NextRequest(url)
}

describe('GET /api/twitch/channel-point-bootstrap', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    __resetTwitchAppTokenForTests()
    process.env.NEXT_PUBLIC_APP_URL = 'https://example.com'
    vi.stubGlobal('fetch', vi.fn())
    const { getSession, canUseStreamerFeatures } = await import('@/lib/session')
    const { checkRateLimit } = await import('@/lib/rate-limit')
    vi.mocked(getSession).mockResolvedValue(session as any)
    vi.mocked(canUseStreamerFeatures).mockReturnValue(true)
    vi.mocked(checkRateLimit).mockResolvedValue({
      success: true,
      limit: 30,
      remaining: 29,
      reset: Date.now() + 60000,
    })
  })

  it('scope不足ならTwitch rewardsを呼ばずreauthを返す', async () => {
    const { hasScope } = await import('@/lib/twitch/token-manager')
    const { getChannelPointsAccessState } = await import('@/lib/twitch/channel-points-access')
    vi.mocked(hasScope).mockResolvedValue(false)

    const { GET } = await import('@/app/api/twitch/channel-point-bootstrap/route')
    const response = await GET(request())
    const body = await response.json()

    expect(body).toMatchObject({ hasRequiredScope: false, rewards: [], requiresReauth: true })
    expect(global.fetch).not.toHaveBeenCalled()
    // #788: scope不足の早期returnでもcapability状態を読み、レスポンスへ含める
    expect(getChannelPointsAccessState).toHaveBeenCalledWith('streamer-1')
    expect(body.capability).toBe('unknown')
    expect(body.capabilityCheckedAt).toBeNull()
  })

  it('diagnostics=0ではscope確認とrewards取得だけを返す', async () => {
    const { hasScope, getTwitchAccessToken } = await import('@/lib/twitch/token-manager')
    vi.mocked(hasScope).mockResolvedValue(true)
    vi.mocked(getTwitchAccessToken).mockResolvedValue('token-1')
    vi.mocked(global.fetch).mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'reward-1', title: 'Reward', cost: 100, is_enabled: true }],
    }), { status: 200 }) as any)

    const { GET } = await import('@/app/api/twitch/channel-point-bootstrap/route')
    const response = await GET(request())
    const body = await response.json()

    expect(body.hasRequiredScope).toBe(true)
    expect(body.rewards).toHaveLength(1)
    expect(body.subscriptions).toBeUndefined()
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('diagnostics=1ではEventSubと追加報酬状態も返す', async () => {
    const { hasScope, getTwitchAccessToken } = await import('@/lib/twitch/token-manager')
    vi.mocked(hasScope).mockResolvedValue(true)
    vi.mocked(getTwitchAccessToken).mockResolvedValue('token-1')
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }) as any)
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'app-token' }), { status: 200 }) as any)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [
          {
            id: 'sub-1',
            status: 'enabled',
            type: 'channel.channel_points_custom_reward_redemption.add',
            condition: { reward_id: 'reward-1' },
            transport: { callback: 'https://example.com/api/twitch/eventsub' },
          },
          {
            id: 'sub-2',
            status: 'enabled',
            type: 'channel.raid',
            condition: { to_broadcaster_user_id: 'streamer-1' },
            transport: { callback: 'https://example.com/api/twitch/eventsub' },
          },
        ],
        pagination: {},
      }), { status: 200 }) as any)

    // ルートは streamer 所有権の一意行と追加報酬一覧を別々に読む。
    // 選択フィールドで結果を振り分け、SQL ビルダーの外形まで実装契約に合わせる。
    const db = {
      select: vi.fn((fields: Record<string, unknown>) => {
        const isStreamerQuery = Object.hasOwn(fields, 'channel_point_reward_id')
        const builder: any = {
          from: vi.fn(() => builder),
          where: vi.fn(() => builder),
          limit: vi.fn().mockResolvedValue([
            { id: 'streamer-db-1', channel_point_reward_id: 'reward-1', raid_gacha_draw_count: 3 },
          ]),
          orderBy: vi.fn().mockResolvedValue([{ id: 'extra-1', reward_id: 'reward-2' }]),
        }
        if (!isStreamerQuery) {
          builder.limit = vi.fn().mockResolvedValue([])
        }
        return builder
      }),
    }
    vi.mocked(getDb).mockResolvedValue({ db } as any)

    const { GET } = await import('@/app/api/twitch/channel-point-bootstrap/route')
    const response = await GET(request('http://localhost:3000/api/twitch/channel-point-bootstrap?diagnostics=1'))
    const body = await response.json()

    expect(body.eventSubStatus).toBe('active')
    expect(body.raidEventSubStatus).toBe('active')
    expect(body.additionalRewards).toHaveLength(1)
    expect(body.raidGiftDrawCount).toBe(3)
  })

  // #788: Capability Probe導入に伴い、旧 error: "affiliateRequired" /
  // "fetchFailed" 契約を廃止し、capability / temporarilyUnavailable ベースの
  // 契約へ置き換えた（route.ts のgetTwitchRewards・GETハンドラ参照）。
  // 以下はその新契約の3ケース（403/401/一時失敗）を検証する。
  it('Twitch 403応答時はrecordChannelPointsApiFailure(403)を呼びcapabilityが最新のDB確定状態を返す（error: affiliateRequiredは返さない）', async () => {
    const { hasScope, getTwitchAccessToken } = await import('@/lib/twitch/token-manager')
    const { getChannelPointsAccessState, recordChannelPointsApiFailure } =
      await import('@/lib/twitch/channel-points-access')
    vi.mocked(hasScope).mockResolvedValue(true)
    vi.mocked(getTwitchAccessToken).mockResolvedValue('token-1')
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 }) as any
    )
    // recordChannelPointsApiFailure(403)がDBへ永続化した後の状態を模す
    // （route は recordChannelPointsApiFailure 呼び出し後に再度状態を読み直す）
    vi.mocked(getChannelPointsAccessState).mockResolvedValueOnce({
      capability: 'unavailable',
      checkedAt: '2026-07-23T00:00:00.000Z',
      enabled: false,
    })

    const { GET } = await import('@/app/api/twitch/channel-point-bootstrap/route')
    const response = await GET(request())
    const body = await response.json()

    expect(recordChannelPointsApiFailure).toHaveBeenCalledWith('streamer-1', 403)
    expect(body.capability).toBe('unavailable')
    expect(body.capabilityCheckedAt).toBe('2026-07-23T00:00:00.000Z')
    expect(body.rewards).toEqual([])
    expect(body.error).toBeUndefined()
  })

  it('Twitch 401応答時はrecordChannelPointsApiFailure(401)を呼びrequiresReauth:trueを返す', async () => {
    const { hasScope, getTwitchAccessToken } = await import('@/lib/twitch/token-manager')
    const { recordChannelPointsApiFailure } = await import('@/lib/twitch/channel-points-access')
    vi.mocked(hasScope).mockResolvedValue(true)
    vi.mocked(getTwitchAccessToken).mockResolvedValue('token-1')
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 }) as any
    )

    const { GET } = await import('@/app/api/twitch/channel-point-bootstrap/route')
    const response = await GET(request())
    const body = await response.json()

    expect(recordChannelPointsApiFailure).toHaveBeenCalledWith('streamer-1', 401)
    expect(body.requiresReauth).toBe(true)
    expect(body.rewards).toEqual([])
  })

  it('Twitch 429/5xx等の一時失敗ではtemporarilyUnavailable:trueを返しDB確定状態は破壊しない(recordChannelPointsApiFailure未呼び出し)', async () => {
    const { hasScope, getTwitchAccessToken } = await import('@/lib/twitch/token-manager')
    const { recordChannelPointsApiFailure } = await import('@/lib/twitch/channel-points-access')
    vi.mocked(hasScope).mockResolvedValue(true)
    vi.mocked(getTwitchAccessToken).mockResolvedValue('token-1')
    // 429/5xxはどちらも「非401/403の非2xx」という同一分岐（!response.ok）を通る
    // ため、代表として429のみ検証する。
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ message: 'Too Many Requests' }), { status: 429 }) as any
    )

    const { GET } = await import('@/app/api/twitch/channel-point-bootstrap/route')
    const response = await GET(request())
    const body = await response.json()

    expect(body.temporarilyUnavailable).toBe(true)
    expect(recordChannelPointsApiFailure).not.toHaveBeenCalled()
  })

  // #788 子E #793 Fableレビュー Major-2: Twitchが実際に200で成功したら、staleな
  // 旧確定状態(unavailable/reauth_required/unknown)をavailableへ自己回復させる。
  it('Twitch 200成功時、保存済みcapabilityがunavailableならavailableへ自己回復させる', async () => {
    const { hasScope, getTwitchAccessToken } = await import('@/lib/twitch/token-manager')
    const { getChannelPointsAccessState, persistChannelPointsCapability } =
      await import('@/lib/twitch/channel-points-access')
    vi.mocked(hasScope).mockResolvedValue(true)
    vi.mocked(getTwitchAccessToken).mockResolvedValue('token-1')
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }) as any
    )
    vi.mocked(getChannelPointsAccessState)
      .mockResolvedValueOnce({ capability: 'unavailable', checkedAt: '2026-07-01T00:00:00.000Z', enabled: false })
      .mockResolvedValueOnce({ capability: 'available', checkedAt: '2026-07-23T00:00:00.000Z', enabled: false })

    const { GET } = await import('@/app/api/twitch/channel-point-bootstrap/route')
    const response = await GET(request())
    const body = await response.json()

    expect(persistChannelPointsCapability).toHaveBeenCalledWith(
      'streamer-1',
      expect.objectContaining({ capability: 'available', definitive: true })
    )
    expect(body.capability).toBe('available')
  })

  it('Twitch 200成功時、保存済みcapabilityが既にavailableなら無駄な書き込みをしない', async () => {
    const { hasScope, getTwitchAccessToken } = await import('@/lib/twitch/token-manager')
    const { getChannelPointsAccessState, persistChannelPointsCapability } =
      await import('@/lib/twitch/channel-points-access')
    vi.mocked(hasScope).mockResolvedValue(true)
    vi.mocked(getTwitchAccessToken).mockResolvedValue('token-1')
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }) as any
    )
    vi.mocked(getChannelPointsAccessState).mockResolvedValue({
      capability: 'available',
      checkedAt: '2026-07-23T00:00:00.000Z',
      enabled: false,
    })

    const { GET } = await import('@/app/api/twitch/channel-point-bootstrap/route')
    await GET(request())

    expect(persistChannelPointsCapability).not.toHaveBeenCalled()
  })

  // 最終レビュー Major-B: 自己回復の書き込み自体が失敗（デプロイ窓・maintenance中の
  // 書き込み不可等）しても、Twitchから実際に取得できた報酬一覧のレスポンスを
  // 500に巻き込んではならない（401/403同期のrecordChannelPointsApiFailureと同じ
  // 「握りつぶす」方針）。
  it('自己回復の書き込みが失敗しても、報酬一覧のレスポンス自体は200のまま返す', async () => {
    const { hasScope, getTwitchAccessToken } = await import('@/lib/twitch/token-manager')
    const { getChannelPointsAccessState, persistChannelPointsCapability } =
      await import('@/lib/twitch/channel-points-access')
    vi.mocked(hasScope).mockResolvedValue(true)
    vi.mocked(getTwitchAccessToken).mockResolvedValue('token-1')
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'reward-1', title: 'Reward', cost: 100, is_enabled: true }] }), { status: 200 }) as any
    )
    vi.mocked(getChannelPointsAccessState).mockResolvedValue({
      capability: 'unavailable',
      checkedAt: '2026-07-01T00:00:00.000Z',
      enabled: false,
    })
    vi.mocked(persistChannelPointsCapability).mockRejectedValueOnce(
      new Error('column "channel_points_capability" does not exist')
    )

    const { GET } = await import('@/app/api/twitch/channel-point-bootstrap/route')
    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.rewards).toHaveLength(1)
  })
})
