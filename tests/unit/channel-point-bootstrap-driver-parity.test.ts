/**
 * Issue #690 (#570 パイロット踏襲): channel-point-bootstrap API の diagnostics=1
 * 経路（getOwnedStreamer / getAdditionalRewards、122-158行目付近）について、
 * postgrest 経路 / pg 経路の応答互換性を検証する。
 *
 * 検証観点（tests/unit/announcements-driver-parity.test.ts と
 * tests/unit/overlay-events-api-pg.test.ts の確立パターンを踏襲）:
 *   1. フル select 経路: 両経路の応答 JSON が deepEqual
 *   2. raid 系カラムのスキーマドリフト時の縮退フォールバック経路
 *      (postgrest: isRaidOptionsSchemaError/isRaidStateSchemaError [PGRST204],
 *       pg: isPgMissingColumnError [42703]) でも両経路の応答 JSON が deepEqual
 *   3. streamer 行なし(maybeSingle → null / pg limit(1) → 空配列)でも
 *      両経路とも404 + STREAMER_NOT_FOUND
 *   4. フラグ分岐（postgrest経路でgetDb不使用／pg経路でsupabase-js不使用）
 *   5. pgクエリの実引数（where/orderBy/limit）の構造比較
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { asc, eq } from 'drizzle-orm'
import { GET } from '@/app/api/twitch/channel-point-bootstrap/route'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { checkRateLimit, getRateLimitIdentifier } from '@/lib/rate-limit'
import { hasScope, getTwitchAccessToken } from '@/lib/twitch/token-manager'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getDb } from '@/lib/db/client'
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
vi.mock('@/lib/twitch/token-manager', () => ({
  hasScope: vi.fn(),
  getTwitchAccessToken: vi.fn(),
}))
vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: vi.fn(),
}))
// handleApiError/handleDatabaseError → logAndRecordError → logErrorFromLogger は
// 既定で getSupabaseAdmin() 経由の "errors" テーブル書き込みを行う（DB_DRIVER 移行
// とは無関係な既存のエラーロギング基盤）。ここではその副作用を排除し、
// getOwnedStreamer/getAdditionalRewards のドライバ分岐だけを純粋に検証できる
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
const mockGetSupabaseAdmin = vi.mocked(getSupabaseAdmin)

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
// フル select 経路の fixture（両経路で同じ論理データを表現する）
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
// postgrest 経路のモック: from(table).select().eq().order()/maybeSingle()
// callIndex を共有することで「フル select 失敗 → フォールバック select 成功」の
// 2回シーケンスを1つのテーブルモックで再現する。
// ---------------------------------------------------------------------------
function makeSequentialTableMock(
  responses: Array<{ data: unknown; error: unknown }>,
  terminal: 'maybeSingle' | 'order'
) {
  let callIndex = 0
  return () => {
    const builder: any = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
    }
    const resolveNext = () => {
      const response = responses[Math.min(callIndex, responses.length - 1)]
      callIndex += 1
      return Promise.resolve(response)
    }
    if (terminal === 'maybeSingle') {
      builder.maybeSingle = vi.fn(resolveNext)
    } else {
      builder.order = vi.fn(resolveNext)
    }
    return builder
  }
}

function createBootstrapSupabaseMock(
  streamerResponses: Array<{ data: unknown; error: unknown }>,
  rewardsResponses: Array<{ data: unknown; error: unknown }> = [{ data: [], error: null }]
) {
  const streamerFactory = makeSequentialTableMock(streamerResponses, 'maybeSingle')
  const rewardsFactory = makeSequentialTableMock(rewardsResponses, 'order')
  const from = vi.fn((table: string) => {
    if (table === 'streamers') return streamerFactory()
    if (table === 'streamer_additional_gacha_rewards') return rewardsFactory()
    throw new Error(`Unexpected table: ${table}`)
  })
  return { from }
}

// ---------------------------------------------------------------------------
// pg 経路のモック: db.select(fields).from(table).where(cond).limit(n)/orderBy(cond)
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

afterEach(() => {
  // db-flags.test.ts 等と同じ変数を扱うため、他テストへ漏れないよう必ず復元する
  vi.unstubAllEnvs()
})

/**
 * diagnostics=1 経路で呼ばれる fetch 呼び出し順: (1) getTwitchRewards の
 * custom_rewards、(2) getAppAccessToken の oauth2/token、(3)
 * getSubscriptionsByUserId の eventsub/subscriptions。EventSub 呼び出しの詳細は
 * ドライバ非依存(channel-point-bootstrap-api.test.ts で別途検証済み)のため、
 * ここでは空データで固定する。
 *
 * 1つの it() 内で postgrest 経路・pg 経路の両方を実行する（deepEqual 比較のため）
 * ケースがあるため、mockResolvedValueOnce の3連鎖は run* 呼び出しのたびに
 * その場でキューに積む(beforeEach で1回だけ積むと2回目のGET呼び出しでキューが
 * 枯渇し、fetchがundefinedを返してTypeErrorになるため)。
 */
function queueDiagnosticsFetchResponses() {
  vi.mocked(global.fetch)
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }) as any)
    .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'app-token' }), { status: 200 }) as any)
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: [], pagination: {} }), { status: 200 }) as any)
}

async function runPostgrestPath(
  streamerResponses: Array<{ data: unknown; error: unknown }>,
  rewardsResponses?: Array<{ data: unknown; error: unknown }>
) {
  vi.stubEnv('DB_DRIVER', undefined)
  queueDiagnosticsFetchResponses()
  const supabase = createBootstrapSupabaseMock(streamerResponses, rewardsResponses)
  mockGetSupabaseAdmin.mockReturnValue(supabase as any)
  const res = await GET(request())
  const body = await res.json()
  return { res, body, supabase }
}

async function runPgPath(
  streamerResponses: Array<{ rows?: Record<string, unknown>[]; error?: unknown }>,
  rewardsResponses?: Array<{ rows?: Record<string, unknown>[]; error?: unknown }>
) {
  vi.stubEnv('DB_DRIVER', 'pg-read')
  queueDiagnosticsFetchResponses()
  const db = createDrizzleBootstrapDbMock(streamerResponses, rewardsResponses)
  vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any)
  const res = await GET(request())
  const body = await res.json()
  return { res, body, db }
}

describe('GET /api/twitch/channel-point-bootstrap?diagnostics=1: フル select 経路の postgrest / pg 互換 (#690)', () => {
  it('同一データで両経路の応答JSONがdeepEqualになる', async () => {
    const { res: postgrestRes, body: postgrestBody } = await runPostgrestPath(
      [{ data: FULL_STREAMER_ROW, error: null }],
      [{ data: [FULL_REWARD_ROW], error: null }]
    )
    const { res: pgRes, body: pgBody } = await runPgPath(
      [{ rows: [FULL_STREAMER_ROW] }],
      [{ rows: [FULL_REWARD_ROW] }]
    )

    expect(postgrestRes.status).toBe(200)
    expect(pgRes.status).toBe(200)
    expect(postgrestBody.additionalRewards).toEqual(EXPECTED_FULL_ADDITIONAL_REWARDS)
    expect(postgrestBody.raidGiftDrawCount).toBe(3)
    expect(pgBody).toEqual(postgrestBody)
  })

  it('postgrest 経路（フラグ未設定）では getDb が一切呼ばれない（挙動不変の検証）', async () => {
    await runPostgrestPath([{ data: FULL_STREAMER_ROW, error: null }], [{ data: [FULL_REWARD_ROW], error: null }])
    expect(getDb).not.toHaveBeenCalled()
  })

  it('pg 経路では supabase-js クライアントが一切呼ばれない', async () => {
    const { db } = await runPgPath([{ rows: [FULL_STREAMER_ROW] }], [{ rows: [FULL_REWARD_ROW] }])
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    // streamers(limit終端) + rewards(orderBy終端) の2回だけ呼ばれる(フォールバック無し)
    expect(db.select).toHaveBeenCalledTimes(2)
  })

  it('pgクエリが streamers/streamer_additional_gacha_rewards への where/orderBy/limit を正しい実引数で呼び出す', async () => {
    const { db } = await runPgPath([{ rows: [FULL_STREAMER_ROW] }], [{ rows: [FULL_REWARD_ROW] }])

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

describe('GET /api/twitch/channel-point-bootstrap?diagnostics=1: raid系カラム欠落時の縮退フォールバック互換 (#690)', () => {
  it('postgrest(PGRST204) / pg(42703) いずれも縮退selectへフォールバックし、応答JSONがdeepEqualになる', async () => {
    const { res: postgrestRes, body: postgrestBody, supabase } = await runPostgrestPath(
      [
        { data: null, error: { code: 'PGRST204', message: 'column streamers.raid_gacha_draw_count does not exist' } },
        { data: FALLBACK_STREAMER_ROW, error: null },
      ],
      [
        {
          data: null,
          error: {
            code: 'PGRST204',
            message: 'column streamer_additional_gacha_rewards.draw_count does not exist',
          },
        },
        { data: [FALLBACK_REWARD_ROW], error: null },
      ]
    )
    const { res: pgRes, body: pgBody, db } = await runPgPath(
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

    expect(postgrestRes.status).toBe(200)
    expect(pgRes.status).toBe(200)
    // 両経路ともフォールバックのデフォルト値(draw_count:1, is_raid_limited:false,
    // raid_gacha_draw_count:0)が補完されていること
    expect(postgrestBody.additionalRewards).toEqual(EXPECTED_FALLBACK_ADDITIONAL_REWARDS)
    expect(postgrestBody.raidGiftDrawCount).toBe(0)
    expect(pgBody).toEqual(postgrestBody)

    // フォールバックが実際に発火した(各テーブル2回ずつクエリされた)ことの確認
    expect(supabase.from).toHaveBeenCalledWith('streamers')
    expect(supabase.from).toHaveBeenCalledWith('streamer_additional_gacha_rewards')
    expect(db.select).toHaveBeenCalledTimes(4)
  })

  it('pgクエリのフォールバック時は縮退select(raid_gacha_draw_count/draw_count/is_raid_limitedを含まない)を発行する', async () => {
    const { db } = await runPgPath(
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
    const { res, db } = await runPgPath([
      { error: { code: '42601', message: 'syntax error' } },
    ])

    expect(res.status).toBe(500)
    // フォールバッククエリは発行されない(1回のみ)
    expect(db.select).toHaveBeenCalledTimes(1)
  })
})

describe('GET /api/twitch/channel-point-bootstrap?diagnostics=1: streamer行なしの postgrest / pg 互換 (#690)', () => {
  it('streamerが見つからない場合、両経路とも404 + STREAMER_NOT_FOUNDでdeepEqualになる', async () => {
    const { res: postgrestRes, body: postgrestBody, supabase } = await runPostgrestPath([
      { data: null, error: null },
    ])
    const { res: pgRes, body: pgBody, db } = await runPgPath([{ rows: [] }])

    expect(postgrestRes.status).toBe(404)
    expect(pgRes.status).toBe(404)
    expect(pgBody).toEqual(postgrestBody)

    // streamer 未検出のため追加報酬クエリには到達しない(両経路とも)
    expect(supabase.from).not.toHaveBeenCalledWith('streamer_additional_gacha_rewards')
    expect(db.select).toHaveBeenCalledTimes(1)
  })
})
