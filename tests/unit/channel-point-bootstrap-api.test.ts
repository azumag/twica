import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { getDb } from '@/lib/db/client'
import { __resetTwitchAppTokenForTests } from '@/lib/twitch/app-token'
import { ERROR_MESSAGES } from '@/lib/constants'

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
vi.mock('@/lib/twitch/token-manager', () => {
  // Issue #1018: routeはinstanceofで再認証要エラーを判定するため、モックにも
  // 実クラスと同形のTwitchTokenErrorを供給する（無いとinstanceof undefinedで
  // TypeErrorになる）。
  class TwitchTokenError extends Error {
    constructor(
      message: string,
      public readonly code: 'NO_TOKEN' | 'REFRESH_FAILED' | 'DATABASE_ERROR' | 'USER_NOT_FOUND',
      public readonly originalError?: Error,
      public readonly refreshStatus?: number,
      public readonly refreshErrorKind?: string,
      public readonly refreshRetryable?: boolean,
    ) {
      super(message)
      this.name = 'TwitchTokenError'
    }
  }
  return {
    TwitchTokenError,
    hasScope: vi.fn(),
    getTwitchAccessToken: vi.fn(),
    // Issue #653/#670: route handlerのcatchが常に呼ぶため固定モックにも必要。
    twitchTokenErrorReportContext: vi.fn().mockReturnValue(undefined),
  }
})
// Issue #1018: catch経路はrecordApiError（記録のみ）またはhandleApiError
// （500）を返す。両者の呼び分けを検証するためモック化する。DB永続化は
// recordApiErrorの内部（sentry/error-handler）で行われるが、テスト環境では
// NEXT_RUNTIME未設定でno-opになるため、モックによる呼び出し検証で代替する。
vi.mock('@/lib/error-handler', () => ({
  handleApiError: vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ error: 'Internal Server Error' }), { status: 500 })
  ),
  handleDatabaseError: vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ error: 'Database error' }), { status: 500 })
  ),
  recordApiError: vi.fn().mockResolvedValue(undefined),
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

  // Issue #1018: トークン恒久失効(REFRESH_FAILEDかつrefreshRetryable ===
  // false)は汎用500ではなく、rewards/emotesルートと同じbody契約の
  // 401+requiresReauthを返し、クライアントがstep-up再認証CTAを表示できるようにする。
  it('REFRESH_FAILED(refreshRetryable=false)は401+requiresReauthを返し、エラー記録とcapability(401)同期を行う', async () => {
    const { hasScope, getTwitchAccessToken, TwitchTokenError } = await import('@/lib/twitch/token-manager')
    const { recordApiError, handleApiError } = await import('@/lib/error-handler')
    const { recordChannelPointsApiFailure } = await import('@/lib/twitch/channel-points-access')
    vi.mocked(hasScope).mockResolvedValue(true)
    const tokenError = new TwitchTokenError(
      'Failed to refresh Twitch access token',
      'REFRESH_FAILED',
      undefined,
      400,
      'http',
      false,
    )
    vi.mocked(getTwitchAccessToken).mockRejectedValue(tokenError)

    const { GET } = await import('@/app/api/twitch/channel-point-bootstrap/route')
    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(401)
    expect(body).toEqual({ error: ERROR_MESSAGES.TWITCH_TOKEN_REQUIRED, requiresReauth: true })
    expect(recordApiError).toHaveBeenCalledWith(tokenError, 'Channel Point Bootstrap API', undefined)
    expect(handleApiError).not.toHaveBeenCalled()
    expect(recordChannelPointsApiFailure).toHaveBeenCalledWith('streamer-1', 401)
  })

  // Issue #1018: refreshRetryable === true(429/5xx/network)は再認証では回復しない
  // 一時失敗のため、従来どおりhandleApiErrorの500を維持しcapability確定状態を壊さない。
  it('REFRESH_FAILED(refreshRetryable=true)は一時失敗のため500(handleApiError)を返しcapabilityは同期しない', async () => {
    const { hasScope, getTwitchAccessToken, TwitchTokenError } = await import('@/lib/twitch/token-manager')
    const { recordApiError, handleApiError } = await import('@/lib/error-handler')
    const { recordChannelPointsApiFailure } = await import('@/lib/twitch/channel-points-access')
    vi.mocked(hasScope).mockResolvedValue(true)
    vi.mocked(getTwitchAccessToken).mockRejectedValue(
      new TwitchTokenError(
        'Failed to refresh Twitch access token',
        'REFRESH_FAILED',
        undefined,
        429,
        'http',
        true,
      ),
    )

    const { GET } = await import('@/app/api/twitch/channel-point-bootstrap/route')
    const response = await GET(request())

    expect(response.status).toBe(500)
    expect(handleApiError).toHaveBeenCalled()
    expect(recordApiError).not.toHaveBeenCalled()
    expect(recordChannelPointsApiFailure).not.toHaveBeenCalled()
  })

  // Issue #1018: DB障害起因のrefresh失敗はdiagnosticが未付与(refreshRetryable ===
  // undefined)になるため再認証要エラーと判定できず、500を維持する。
  it('REFRESH_FAILEDでdiagnostic未付与(DB起因失敗)は500(handleApiError)を返しcapabilityは同期しない', async () => {
    const { hasScope, getTwitchAccessToken, TwitchTokenError } = await import('@/lib/twitch/token-manager')
    const { recordApiError, handleApiError } = await import('@/lib/error-handler')
    const { recordChannelPointsApiFailure } = await import('@/lib/twitch/channel-points-access')
    vi.mocked(hasScope).mockResolvedValue(true)
    vi.mocked(getTwitchAccessToken).mockRejectedValue(
      new TwitchTokenError('Failed to refresh Twitch access token', 'REFRESH_FAILED', new Error('db down')),
    )

    const { GET } = await import('@/app/api/twitch/channel-point-bootstrap/route')
    const response = await GET(request())

    expect(response.status).toBe(500)
    expect(handleApiError).toHaveBeenCalled()
    expect(recordApiError).not.toHaveBeenCalled()
    expect(recordChannelPointsApiFailure).not.toHaveBeenCalled()
  })

  // Issue #1018: NO_TOKENは現在の実装では到達しない防御的経路だが、
  // 401+requiresReauthの契約をここで固定する。
  it('NO_TOKEN(防御的経路)は401+requiresReauthを返す', async () => {
    const { hasScope, getTwitchAccessToken, TwitchTokenError } = await import('@/lib/twitch/token-manager')
    const { recordChannelPointsApiFailure } = await import('@/lib/twitch/channel-points-access')
    vi.mocked(hasScope).mockResolvedValue(true)
    vi.mocked(getTwitchAccessToken).mockRejectedValue(
      new TwitchTokenError('No Twitch token found', 'NO_TOKEN'),
    )

    const { GET } = await import('@/app/api/twitch/channel-point-bootstrap/route')
    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(401)
    expect(body).toEqual({ error: ERROR_MESSAGES.TWITCH_TOKEN_REQUIRED, requiresReauth: true })
    expect(recordChannelPointsApiFailure).toHaveBeenCalledWith('streamer-1', 401)
  })

  // Issue #1018 リグレッションガード: トークンエラー以外(汎用Error等)は
  // 従来どおり500を維持し、誤って401+requiresReauthにしない。
  it('非トークンエラー(汎用Error)は500(handleApiError)を維持する', async () => {
    const { hasScope, getTwitchAccessToken } = await import('@/lib/twitch/token-manager')
    const { recordApiError, handleApiError } = await import('@/lib/error-handler')
    const { recordChannelPointsApiFailure } = await import('@/lib/twitch/channel-points-access')
    vi.mocked(hasScope).mockResolvedValue(true)
    vi.mocked(getTwitchAccessToken).mockRejectedValue(new Error('unexpected db failure'))

    const { GET } = await import('@/app/api/twitch/channel-point-bootstrap/route')
    const response = await GET(request())

    expect(response.status).toBe(500)
    expect(handleApiError).toHaveBeenCalled()
    expect(recordApiError).not.toHaveBeenCalled()
    expect(recordChannelPointsApiFailure).not.toHaveBeenCalled()
  })
})
