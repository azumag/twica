/**
 * Issue #690 (#570 パイロット踏襲): channel-point-bootstrap API の diagnostics=1
 * 経路（getOwnedStreamer / getAdditionalRewards、122-158行目付近）について、
 * PlanetScale/Drizzle 経路の応答・SQL契約を検証する。
 *
 * 検証観点（tests/unit/announcements-driver-parity.test.ts と
 * tests/unit/overlay-events-api-pg.test.ts の確立パターンを踏襲）:
 *   1. フル select 経路の応答 JSON
 *   2. raid 系カラムのスキーマドリフト時の縮退フォールバック経路
 *      (isPgMissingColumnError [42703])
 *   3. streamer 行なし(limit(1) → 空配列)で404 + STREAMER_NOT_FOUND
 *   4. クエリの実引数（where/orderBy/limit）の構造比較
 *   6. 【厳格レビュー指摘 nit-4】縮退フォールバック自身も失敗するケース:
 *      getOwnedStreamer/getAdditionalRewards それぞれで「初回スキーマエラー →
 *      フォールバッククエリも失敗」した場合に500となること
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { asc, eq } from 'drizzle-orm'
import { GET } from '@/app/api/twitch/channel-point-bootstrap/route'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { checkRateLimit, getRateLimitIdentifier } from '@/lib/rate-limit'
import { hasScope, getTwitchAccessToken } from '@/lib/twitch/token-manager'
import { getDb } from '@/lib/db/client'
import { ERROR_MESSAGES } from '@/lib/constants'
import { __resetTwitchAppTokenForTests } from '@/lib/twitch/app-token'
import {
  streamers as streamersTable,
  streamerAdditionalGachaRewards as streamerAdditionalGachaRewardsTable,
} from '@/lib/db/schema'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/session', () => ({
  getSession: vi.fn(),
  canUseStreamerFeatures: vi.fn(),
}))
vi.mock('@/lib/rate-limit', () => ({
  getRateLimitIdentifier: vi.fn(),
  checkRateLimit: vi.fn(),
  rateLimits: { twitchRewardsGet: { windowMs: 60000, max: 30 } },
}))
vi.mock('@/lib/twitch/token-manager', () => {
  // Issue #1018: routeのcatchはTwitchTokenErrorのinstanceof判定を行うため、
  // 固定モックにもクラス本体を供給する必要がある（無いとinstanceofが
  // TypeError）。このファイルの検証対象(streamers/rewards SQL契約)には
  // 非TwitchTokenError系エラーしか経由しないため、最小クラスで十分。
  class TwitchTokenError extends Error {
    constructor(
      message: string,
      public readonly code: string,
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
    // Issue #653/#670: route handlerのcatchが常に呼ぶため、固定モックにも
    // 用意する必要がある。このファイルの検証対象(streamers/rewards SQL契約)
    // とは無関係な非TwitchTokenError系エラーしか経由しないため、常にundefinedを
    // 返す実装で十分(handleApiErrorのadditionalInfoが常にundefinedになるだけ)。
    twitchTokenErrorReportContext: vi.fn().mockReturnValue(undefined),
  }
})
// #788: capability probe の永続化状態を読む/書くヘルパー。このテストファイルは
// getOwnedStreamer/getAdditionalRewards の SQL 契約だけを検証対象としており、
// capability state 自体は channel-points-access.ts 側の責務。ここをモックせず
// 実装のまま呼ばせると、GET ハンドラが必ず呼ぶ getChannelPointsAccessState が
// 「users」テーブル/クエリを追加で叩いてしまい、このファイルが検証したい
// streamers/streamer_additional_gacha_rewards への呼び出し回数・実引数の
// アサーションを汚染する（db.select 呼び出し回数が streamers/rewards 分の
// 期待値からズレる等）。モジュール全体を固定値でモックし、本来の検証対象に集中させる。
vi.mock('@/lib/twitch/channel-points-access', () => ({
  getChannelPointsAccessState: vi.fn().mockResolvedValue({
    capability: 'unknown',
    checkedAt: null,
    enabled: false,
  }),
  recordChannelPointsApiFailure: vi.fn().mockResolvedValue(undefined),
  persistChannelPointsCapability: vi.fn().mockResolvedValue(undefined),
}))
// handleApiError/handleDatabaseError → logAndRecordError → logErrorFromLogger は
// 既定ではエラー記録の DB 書き込みを行う。ここではその副作用を排除し、
// getOwnedStreamer/getAdditionalRewards のクエリだけを純粋に検証できる
// ようにする（overlay-events-api-pg.test.ts と同じ対処）。
vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn(),
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}))

const mockGetSession = vi.mocked(getSession)
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures)
const mockCheckRateLimit = vi.mocked(checkRateLimit)
const mockGetRateLimitIdentifier = vi.mocked(getRateLimitIdentifier)
const mockHasScope = vi.mocked(hasScope)
const mockGetTwitchAccessToken = vi.mocked(getTwitchAccessToken)

const TWITCH_USER_ID = 'streamer-1'

const session = {
  twitchUserId: TWITCH_USER_ID,
  twitchUsername: 'streamer',
  twitchDisplayName: 'Streamer',
  twitchProfileImageUrl: null,
  broadcasterType: 'affiliate',
  expiresAt: Date.now() + 10000,
  version: 1,
}

function request(): NextRequest {
  return new NextRequest('http://localhost:3000/api/twitch/channel-point-bootstrap?diagnostics=1')
}

// ---------------------------------------------------------------------------
// フル select 経路の fixture
// ---------------------------------------------------------------------------
const FULL_STREAMER_ROW = {
  id: 'streamer-db-1',
  channel_point_reward_id: 'reward-1',
  raid_gacha_draw_count: 3,
}
const FULL_REWARD_ROW = {
  id: 'extra-1',
  reward_id: 'reward-2',
  reward_name: 'Extra Reward',
  draw_count: 2,
  is_raid_limited: true,
  created_at: '2020-01-01T00:00:00.000+00:00',
}

// raid 系カラムが欠落した状態(スキーマドリフトのデプロイ窓)で返る行
const FALLBACK_STREAMER_ROW = {
  id: 'streamer-db-1',
  channel_point_reward_id: 'reward-1',
}
const FALLBACK_REWARD_ROW = {
  id: 'extra-1',
  reward_id: 'reward-2',
  reward_name: 'Extra Reward',
  created_at: '2020-01-01T00:00:00.000+00:00',
}

const EXPECTED_FULL_ADDITIONAL_REWARDS = [FULL_REWARD_ROW]
const EXPECTED_FALLBACK_ADDITIONAL_REWARDS = [
  { ...FALLBACK_REWARD_ROW, draw_count: 1, is_raid_limited: false },
]

// ---------------------------------------------------------------------------
// PlanetScale/Drizzle 経路のモック: db.select(fields).from(table).where(cond).limit(n)/orderBy(cond)
// getOwnedStreamerPg は limit() で終端、getAdditionalRewardsPg は orderBy() で終端
// するため、呼び出された終端メソッドで streamer 用/rewards 用のレスポンス列を
// 判別する(overlay-events-api-pg.test.ts の createDrizzleOverlayDbMock と同じ
// 「呼び出し順に fixture を消費する」方式)。
// ---------------------------------------------------------------------------
interface DrizzleCallRecord {
  fields: Record<string, unknown>
  table?: unknown
  whereCondition?: unknown
  orderByCondition?: unknown
  limitValue?: number
}

function createDrizzleBootstrapDbMock(
  streamerResponses: Array<{ rows?: Record<string, unknown>[]; error?: unknown }>,
  rewardsResponses: Array<{ rows?: Record<string, unknown>[]; error?: unknown }> = [{ rows: [] }]
) {
  const calls: DrizzleCallRecord[] = []
  let streamerCallIndex = 0
  let rewardCallIndex = 0
  const select = vi.fn((fields: Record<string, unknown>) => {
    const call: DrizzleCallRecord = { fields }
    calls.push(call)
    const builder: any = {
      from: vi.fn((table: unknown) => {
        call.table = table
        return builder
      }),
      where: vi.fn((condition: unknown) => {
        call.whereCondition = condition
        return builder
      }),
      orderBy: vi.fn((condition: unknown) => {
        call.orderByCondition = condition
        const response = rewardsResponses[Math.min(rewardCallIndex, rewardsResponses.length - 1)]
        rewardCallIndex += 1
        if (response.error) return Promise.reject(response.error)
        const projected = (response.rows ?? []).map((row) =>
          Object.fromEntries(Object.keys(fields).map((key) => [key, row[key]]))
        )
        return Promise.resolve(projected)
      }),
      limit: vi.fn((n: number) => {
        call.limitValue = n
        const response = streamerResponses[Math.min(streamerCallIndex, streamerResponses.length - 1)]
        streamerCallIndex += 1
        if (response.error) return Promise.reject(response.error)
        const projected = (response.rows ?? []).map((row) =>
          Object.fromEntries(Object.keys(fields).map((key) => [key, row[key]]))
        )
        return Promise.resolve(projected)
      }),
    }
    return builder
  })
  return { select, calls }
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetTwitchAppTokenForTests()
  process.env.NEXT_PUBLIC_APP_URL = 'https://example.com'
  process.env.NEXT_PUBLIC_TWITCH_CLIENT_ID = 'client-id'
  vi.stubGlobal('fetch', vi.fn())
  mockGetSession.mockResolvedValue(session as any)
  mockCanUseStreamerFeatures.mockReturnValue(true)
  mockCheckRateLimit.mockResolvedValue({
    success: true,
    limit: 30,
    remaining: 29,
    reset: Date.now() + 60000,
  })
  mockGetRateLimitIdentifier.mockResolvedValue('user:' + TWITCH_USER_ID)
  mockHasScope.mockResolvedValue(true)
  mockGetTwitchAccessToken.mockResolvedValue('token-1')
})

/**
 * diagnostics=1 経路で呼ばれる fetch 呼び出し順: (1) getTwitchRewards の
 * custom_rewards、(2) getAppAccessToken の oauth2/token、(3)
 * getSubscriptionsByUserId の eventsub/subscriptions。EventSub 呼び出しの詳細は
 * ドライバ非依存(channel-point-bootstrap-api.test.ts で別途検証済み)のため、
 * ここでは空データで固定する。
 *
 * mockResolvedValueOnce の3連鎖は各 GET 呼び出し直前にキューへ積む。
 */
function queueDiagnosticsFetchResponses() {
  vi.mocked(global.fetch)
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }) as any)
    .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'app-token' }), { status: 200 }) as any)
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: [], pagination: {} }), { status: 200 }) as any)
}

async function runPlanetscalePath(
  streamerResponses: Array<{ rows?: Record<string, unknown>[]; error?: unknown }>,
  rewardsResponses?: Array<{ rows?: Record<string, unknown>[]; error?: unknown }>
) {
  queueDiagnosticsFetchResponses()
  const db = createDrizzleBootstrapDbMock(streamerResponses, rewardsResponses)
  vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any)
  const res = await GET(request())
  const body = await res.json()
  return { res, body, db }
}

describe('GET /api/twitch/channel-point-bootstrap?diagnostics=1: フル select 経路 (#690)', () => {
  it('PlanetScale の同一データを応答JSONへ反映する', async () => {
    const { res, body } = await runPlanetscalePath(
      [{ rows: [FULL_STREAMER_ROW] }],
      [{ rows: [FULL_REWARD_ROW] }]
    )

    expect(res.status).toBe(200)
    expect(body.additionalRewards).toEqual(EXPECTED_FULL_ADDITIONAL_REWARDS)
    expect(body.raidGiftDrawCount).toBe(3)
  })

  it('streamers と rewards を各1回ずつ取得する', async () => {
    const { db } = await runPlanetscalePath([{ rows: [FULL_STREAMER_ROW] }], [{ rows: [FULL_REWARD_ROW] }])
    // streamers(limit終端) + rewards(orderBy終端) の2回だけ呼ばれる(フォールバック無し)
    expect(db.select).toHaveBeenCalledTimes(2)
  })

  it('クエリが streamers/streamer_additional_gacha_rewards への where/orderBy/limit を正しい実引数で呼び出す', async () => {
    const { db } = await runPlanetscalePath([{ rows: [FULL_STREAMER_ROW] }], [{ rows: [FULL_REWARD_ROW] }])

    expect(db.calls).toHaveLength(2)
    const streamerCall = db.calls[0]
    expect(streamerCall.table).toBe(streamersTable)
    expect(streamerCall.whereCondition).toEqual(eq(streamersTable.twitch_user_id, TWITCH_USER_ID))
    expect(streamerCall.limitValue).toBe(1)

    const rewardsCall = db.calls[1]
    expect(rewardsCall.table).toBe(streamerAdditionalGachaRewardsTable)
    expect(rewardsCall.whereCondition).toEqual(
      eq(streamerAdditionalGachaRewardsTable.streamer_id, FULL_STREAMER_ROW.id)
    )
    expect(rewardsCall.orderByCondition).toEqual(asc(streamerAdditionalGachaRewardsTable.created_at))
  })
})

describe('GET /api/twitch/channel-point-bootstrap?diagnostics=1: raid系カラム欠落時の縮退フォールバック (#690)', () => {
  it('42703では縮退selectへフォールバックし、既定値を補完する', async () => {
    const { res, body, db } = await runPlanetscalePath(
      [
        {
          error: {
            code: '42703',
            message: 'column "raid_gacha_draw_count" of relation "streamers" does not exist',
          },
        },
        { rows: [FALLBACK_STREAMER_ROW] },
      ],
      [
        {
          error: {
            code: '42703',
            message: 'column "draw_count" of relation "streamer_additional_gacha_rewards" does not exist',
          },
        },
        { rows: [FALLBACK_REWARD_ROW] },
      ]
    )

    expect(res.status).toBe(200)
    expect(body.additionalRewards).toEqual(EXPECTED_FALLBACK_ADDITIONAL_REWARDS)
    expect(body.raidGiftDrawCount).toBe(0)

    // フォールバックが実際に発火した(各テーブル2回ずつクエリされた)ことの確認
    expect(db.select).toHaveBeenCalledTimes(4)
  })

  it('フォールバック時は縮退select(raid_gacha_draw_count/draw_count/is_raid_limitedを含まない)を発行する', async () => {
    const { db } = await runPlanetscalePath(
      [
        {
          error: {
            code: '42703',
            message: 'column "raid_gacha_draw_count" of relation "streamers" does not exist',
          },
        },
        { rows: [FALLBACK_STREAMER_ROW] },
      ],
      [
        {
          error: {
            code: '42703',
            message: 'column "draw_count" of relation "streamer_additional_gacha_rewards" does not exist',
          },
        },
        { rows: [FALLBACK_REWARD_ROW] },
      ]
    )

    expect(db.calls).toHaveLength(4)
    // 1回目(streamers, フル select)は raid_gacha_draw_count を含む
    expect(Object.keys(db.calls[0].fields)).toContain('raid_gacha_draw_count')
    // 2回目(streamers, フォールバック select)は raid_gacha_draw_count を含まない
    expect(Object.keys(db.calls[1].fields)).not.toContain('raid_gacha_draw_count')
    // 3回目(rewards, フル select)は draw_count / is_raid_limited を含む
    expect(Object.keys(db.calls[2].fields)).toEqual(
      expect.arrayContaining(['draw_count', 'is_raid_limited'])
    )
    // 4回目(rewards, フォールバック select)は draw_count / is_raid_limited を含まない
    expect(Object.keys(db.calls[3].fields)).not.toContain('draw_count')
    expect(Object.keys(db.calls[3].fields)).not.toContain('is_raid_limited')
  })

  it('42703以外の恒久的エラーはフォールバックせず500(handleApiError経由)になる', async () => {
    const { res, db } = await runPlanetscalePath([
      { error: { code: '42601', message: 'syntax error' } },
    ])

    expect(res.status).toBe(500)
    // フォールバッククエリは発行されない(1回のみ)
    expect(db.select).toHaveBeenCalledTimes(1)
  })
})

describe('GET /api/twitch/channel-point-bootstrap?diagnostics=1: streamer行なし (#690)', () => {
  it('streamerが見つからない場合、404 + STREAMER_NOT_FOUNDになる', async () => {
    const { res, body, db } = await runPlanetscalePath([{ rows: [] }])

    expect(res.status).toBe(404)
    expect(body).toEqual({ error: ERROR_MESSAGES.STREAMER_NOT_FOUND })

    // streamer 未検出のため追加報酬クエリには到達しない。
    expect(db.select).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// 厳格レビュー指摘 (nit-4): 縮退フォールバック自身も失敗するケース。
// 「初回スキーマエラー→フォールバックへ切り替え」までは上の describe
// ブロックで検証済みだが、フォールバッククエリ自体が失敗した場合の経路は
// 未検証だった。getOwnedStreamer は { streamer: null, error } を返し
// handleDatabaseError 経由で固定レスポンス({ error: 'Database error' }, 500)、
// getAdditionalRewards は throw して外側の try/catch → handleApiError 経由で
// 固定レスポンス({ error: ERROR_MESSAGES.INTERNAL_ERROR }, 500) になる
// レスポンス本文は固定値。route.ts の該当 JSDoc 参照）。
// ---------------------------------------------------------------------------
describe('GET /api/twitch/channel-point-bootstrap?diagnostics=1: 縮退フォールバック自身も失敗するケース (#690 厳格レビュー nit-4)', () => {
  it('getOwnedStreamer: 初回スキーマエラー→縮退fallbackも失敗した場合、500 + { error: "Database error" }になる', async () => {
    const { res, body } = await runPlanetscalePath([
      {
        error: {
          code: '42703',
          message: 'column "raid_gacha_draw_count" of relation "streamers" does not exist',
        },
      },
      // フォールバッククエリの2回目も throw（getOwnedStreamerPg は内側 try/catch で
      // 捕捉し { streamer: null, error: fallbackError } に写像する）。
      // 42601(syntax_error)は RETRYABLE_SQLSTATES に含まれない恒久的エラーの例
      // （上の「42703以外の恒久的エラーは...」テストと同じ選択。retryable な
      // コードだと withDbRetry のバックオフ待機でテストが不必要に遅くなるため）。
      { error: { code: '42601', message: 'syntax error during fallback' } },
    ])

    expect(res.status).toBe(500)
    expect(body).toEqual({ error: 'Database error' })
  })

  it('getAdditionalRewards: 初回スキーマエラー→縮退fallbackも失敗した場合、500 + { error: INTERNAL_ERROR }になる', async () => {
    const { res, body } = await runPlanetscalePath(
      [{ rows: [FULL_STREAMER_ROW] }],
      [
        {
          error: {
            code: '42703',
            message: 'column "draw_count" of relation "streamer_additional_gacha_rewards" does not exist',
          },
        },
        // getAdditionalRewardsPg のフォールバック select は try/catch で囲われて
        // いないため、この throw がそのまま呼び出し元(GET の外側 try/catch)まで
        // 伝播する。42601 は非 retryable（上の getOwnedStreamer テストと同じ理由）。
        { error: { code: '42601', message: 'syntax error during fallback' } },
      ]
    )

    expect(res.status).toBe(500)
    expect(body).toEqual({ error: ERROR_MESSAGES.INTERNAL_ERROR })
  })
})
