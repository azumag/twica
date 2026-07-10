/**
 * #663: POST /api/streamer/settings の postgrest 経路 / pg 経路の互換テスト。
 *
 * tests/unit/battle-routes-driver-parity.test.ts / tests/unit/twitch-sub-check-driver-parity.test.ts
 * と同じ流儀（同一 fixture を両経路に与えて HTTP ステータス・レスポンス body・
 * 副作用（UPDATE/upsert/DELETE に渡る値）を突き合わせる）。
 *
 * このハンドラは streamers への複数回の UPDATE・streamer_chat_sender_settings への
 * upsert・twitch_bot_accounts への DELETE を含む読み書き混在ハンドラのため、
 * route.ts 側は isPgWriteEnabled()（DB_DRIVER=pg のときのみ）で全 DB アクセスを
 * まとめて分岐する。942行・多数の設定項目を持つルートのため、本ファイルは
 * 「テーブルごとの読み書き1つにつき代表的な成功/失敗ケース」に絞る
 * （全設定項目の組み合わせ網羅は既存の tests/unit/streamer-settings-api.test.ts が
 * postgrest 経路側で担っている）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/streamer/settings/route'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { checkRateLimit } from '@/lib/rate-limit'
import { validateCSRFToken } from '@/lib/csrf'
import { validateContentType } from '@/lib/request-validation'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getUserPlan } from '@/lib/plan'
import { legacySoundToRules } from '@/lib/gacha-sound-rules'
import { getDb } from '@/lib/db/client'
import {
  streamers as streamersTable,
  streamerChatSenderSettings as streamerChatSenderSettingsTable,
  twitchBotAccounts as twitchBotAccountsTable,
} from '@/lib/db/schema'

vi.mock('@/lib/session')
vi.mock('@/lib/csrf')
vi.mock('@/lib/request-validation')
vi.mock('@/lib/plan')
vi.mock('@/lib/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit')>()
  return { ...actual, checkRateLimit: vi.fn() }
})

const mockGetSession = vi.mocked(getSession)
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures)
const mockCheckRateLimit = vi.mocked(checkRateLimit)
const mockValidateCSRFToken = vi.mocked(validateCSRFToken)
const mockValidateContentType = vi.mocked(validateContentType)
const mockGetSupabaseAdmin = vi.mocked(getSupabaseAdmin)
const mockGetUserPlan = vi.mocked(getUserPlan)

const MOCK_SESSION = {
  twitchUserId: 'streamer123',
  twitchUsername: 'testuser',
  twitchDisplayName: 'Test User',
  twitchProfileImageUrl: 'https://example.com/avatar.jpg',
  broadcasterType: 'affiliate' as const,
  expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
  version: 1,
}

const STREAMER_ROW = {
  id: 'streamer123',
  channel_point_collection_name: null as string | null,
  card_pack_names: [] as string[],
  pack_rarity_weights: null as Record<string, Record<string, number>> | null,
}

function createSettingsRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/streamer/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ streamerId: 'streamer123', ...body }),
  })
}

function allowRequest() {
  mockGetSession.mockResolvedValue(MOCK_SESSION)
  mockCanUseStreamerFeatures.mockReturnValue(true)
  mockValidateCSRFToken.mockResolvedValue({ valid: true })
  mockValidateContentType.mockReturnValue(null)
  mockCheckRateLimit.mockResolvedValue({
    success: true,
    limit: 10,
    remaining: 9,
    reset: Date.now() + 60000,
  })
  mockGetUserPlan.mockResolvedValue('support')
}

// ---------------------------------------------------------------------------
// postgrest 経路のモック: from() 呼び出しごとに応答キューを消費する thenable builder
// （battle-routes-driver-parity.test.ts と同方式）。maybeSingle() 経由（SELECT）と
// builder 自身の then 経由（UPDATE/upsert/DELETE を直接 await する既存コード）の
// 両方の終端を持つ。
// ---------------------------------------------------------------------------

interface SupabaseResponse {
  data?: unknown
  error?: unknown
}

interface SupabaseCall {
  table: string
  method: string
  args: unknown[]
}

function createSupabaseClientMock(responses: SupabaseResponse[]) {
  let index = 0
  const calls: SupabaseCall[] = []
  const from = vi.fn((table: string) => {
    const response = responses[Math.min(index, responses.length - 1)]
    index += 1
    const result = { data: response.data ?? null, error: response.error ?? null }
    const builder: any = {
      select: vi.fn((...args: unknown[]) => {
        calls.push({ table, method: 'select', args })
        return builder
      }),
      update: vi.fn((...args: unknown[]) => {
        calls.push({ table, method: 'update', args })
        return builder
      }),
      upsert: vi.fn((...args: unknown[]) => {
        calls.push({ table, method: 'upsert', args })
        return builder
      }),
      delete: vi.fn(() => {
        calls.push({ table, method: 'delete', args: [] })
        return builder
      }),
      eq: vi.fn((...args: unknown[]) => {
        calls.push({ table, method: 'eq', args })
        return builder
      }),
      maybeSingle: vi.fn(() => Promise.resolve(result)),
      then: (onFulfilled: any, onRejected: any) => Promise.resolve(result).then(onFulfilled, onRejected),
    }
    return builder
  })
  return { from, calls }
}

// ---------------------------------------------------------------------------
// pg 経路のモック（battle-routes-driver-parity.test.ts の select/insert 版に
// update/delete/insert-onConflictDoUpdate を追加したもの）。select は「指定された
// 列だけ」を fixture 行から射影して返す。
// ---------------------------------------------------------------------------

interface PgSelectResponse {
  rows?: Array<Record<string, unknown>>
  error?: unknown
}

interface PgWriteResponse {
  error?: unknown
}

function createDrizzleDbMock(
  config: {
    selects?: PgSelectResponse[]
    updates?: PgWriteResponse[]
    deletes?: PgWriteResponse[]
    upserts?: PgWriteResponse[]
  } = {}
) {
  let selectIndex = 0
  let updateIndex = 0
  let deleteIndex = 0
  let upsertIndex = 0

  const selectCalls: Array<{ fields: Record<string, unknown>; where?: unknown; limit?: number }> = []
  const updateCalls: Array<{ table: unknown; set?: Record<string, unknown>; where?: unknown }> = []
  const deleteCalls: Array<{ table: unknown; where?: unknown }> = []
  const upsertCalls: Array<{
    table: unknown
    values?: Record<string, unknown>
    target?: unknown
    set?: Record<string, unknown>
  }> = []

  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      const call: (typeof selectCalls)[number] = { fields }
      selectCalls.push(call)
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
        where: vi.fn((cond: unknown) => {
          call.where = cond
          return builder
        }),
        limit: vi.fn((n: number) => {
          call.limit = n
          return builder
        }),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
    update: vi.fn((table: unknown) => {
      const call: (typeof updateCalls)[number] = { table }
      updateCalls.push(call)
      return {
        set: vi.fn((data: Record<string, unknown>) => {
          call.set = data
          return {
            where: vi.fn((cond: unknown) => {
              call.where = cond
              const responses = config.updates ?? [{}]
              const response = responses[Math.min(updateIndex, responses.length - 1)]
              updateIndex += 1
              return response.error ? Promise.reject(response.error) : Promise.resolve(undefined)
            }),
          }
        }),
      }
    }),
    delete: vi.fn((table: unknown) => {
      const call: (typeof deleteCalls)[number] = { table }
      deleteCalls.push(call)
      return {
        where: vi.fn((cond: unknown) => {
          call.where = cond
          const responses = config.deletes ?? [{}]
          const response = responses[Math.min(deleteIndex, responses.length - 1)]
          deleteIndex += 1
          return response.error ? Promise.reject(response.error) : Promise.resolve(undefined)
        }),
      }
    }),
    insert: vi.fn((table: unknown) => {
      const call: (typeof upsertCalls)[number] = { table }
      upsertCalls.push(call)
      return {
        values: vi.fn((values: Record<string, unknown>) => {
          call.values = values
          return {
            onConflictDoUpdate: vi.fn((opts: { target: unknown; set: Record<string, unknown> }) => {
              call.target = opts.target
              call.set = opts.set
              const responses = config.upserts ?? [{}]
              const response = responses[Math.min(upsertIndex, responses.length - 1)]
              upsertIndex += 1
              return response.error ? Promise.reject(response.error) : Promise.resolve(undefined)
            }),
          }
        }),
      }
    }),
  }

  return { db, selectCalls, updateCalls, deleteCalls, upsertCalls }
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any)
}

// 列欠落エラー（両経路共通の fixture）。message にターゲット列名と
// "does not exist" を含めることで、postgrest 経路の isMissingXxxColumnError
// （テキスト判定）・pg 経路の同ヘルパー（postgres.js の PostgresError も同じ文言を
// 持つため流用可能。route.ts の fetchStreamerForSettingsPg / updateStreamerSettingsPg
// の doc コメント参照）の両方が同じ結果になる。
function missingColumnError(column: string) {
  return { code: '42703', message: `column "${column}" does not exist` }
}

beforeEach(() => {
  vi.clearAllMocks()
  allowRequest()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('POST /api/streamer/settings（読み書き混在: DB_DRIVER=pg のときのみ pg 経路）', () => {
  describe('所有権確認 SELECT (streamers)', () => {
    it('成功時: 基本フィールド更新で両経路のレスポンス body と UPDATE 値が一致する', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock([{ data: STREAMER_ROW }, { error: undefined }])
      mockGetSupabaseAdmin.mockReturnValue(client as any)
      const postgrestRes = await POST(
        createSettingsRequest({ channelPointRewardId: 'reward-1', channelPointRewardName: 'Reward One' })
      )
      const postgrestBody = await postgrestRes.json()

      vi.stubEnv('DB_DRIVER', 'pg')
      const pg = createDrizzleDbMock({
        selects: [{ rows: [STREAMER_ROW] }],
        updates: [{}],
      })
      primePgDb(pg)
      const pgRes = await POST(
        createSettingsRequest({ channelPointRewardId: 'reward-1', channelPointRewardName: 'Reward One' })
      )
      const pgBody = await pgRes.json()

      expect(pgRes.status).toBe(postgrestRes.status)
      expect(pgRes.status).toBe(200)
      expect(pgBody).toEqual(postgrestBody)
      expect(pgBody).toEqual({ success: true, recalculatedCards: null })

      expect(pg.updateCalls).toHaveLength(1)
      expect(pg.updateCalls[0].table).toBe(streamersTable)
      expect(pg.updateCalls[0].set).toEqual({
        channel_point_reward_id: 'reward-1',
        channel_point_reward_name: 'Reward One',
      })
    })

    it('streamer が見つからない(0行): 両経路とも403（UPDATEは実行されない）', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock([{ data: null }])
      mockGetSupabaseAdmin.mockReturnValue(client as any)
      const postgrestRes = await POST(createSettingsRequest({ channelPointRewardId: 'reward-1' }))

      vi.stubEnv('DB_DRIVER', 'pg')
      const pg = createDrizzleDbMock({ selects: [{ rows: [] }] })
      primePgDb(pg)
      const pgRes = await POST(createSettingsRequest({ channelPointRewardId: 'reward-1' }))

      expect(pgRes.status).toBe(postgrestRes.status)
      expect(pgRes.status).toBe(403)
      expect(await pgRes.json()).toEqual(await postgrestRes.json())
      expect(pg.updateCalls).toHaveLength(0)
    })

    it('pack_rarity_weights 列が未デプロイ: 両経路ともデプロイ窓フォールバックで保存継続（200）', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock([
        { error: missingColumnError('pack_rarity_weights') },
        { data: { id: 'streamer123', channel_point_collection_name: null, card_pack_names: [] } },
        { error: undefined },
      ])
      mockGetSupabaseAdmin.mockReturnValue(client as any)
      const postgrestRes = await POST(createSettingsRequest({ channelPointRewardId: 'reward-1' }))
      const postgrestBody = await postgrestRes.json()

      vi.stubEnv('DB_DRIVER', 'pg')
      const pg = createDrizzleDbMock({
        selects: [
          { error: missingColumnError('pack_rarity_weights') },
          { rows: [{ id: 'streamer123', channel_point_collection_name: null, card_pack_names: [] }] },
        ],
        updates: [{}],
      })
      primePgDb(pg)
      const pgRes = await POST(createSettingsRequest({ channelPointRewardId: 'reward-1' }))
      const pgBody = await pgRes.json()

      expect(pgRes.status).toBe(postgrestRes.status)
      expect(pgRes.status).toBe(200)
      expect(pgBody).toEqual(postgrestBody)
      expect(pgBody).toEqual({ success: true, recalculatedCards: null })
    })
  })

  describe('streamers への主 UPDATE', () => {
    it('UPDATE 失敗: 両経路とも500 + 同一body', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock([{ data: STREAMER_ROW }, { error: { message: 'boom' } }])
      mockGetSupabaseAdmin.mockReturnValue(client as any)
      const postgrestRes = await POST(createSettingsRequest({ channelPointRewardId: 'reward-1' }))

      vi.stubEnv('DB_DRIVER', 'pg')
      const pg = createDrizzleDbMock({
        selects: [{ rows: [STREAMER_ROW] }],
        updates: [{ error: { code: 'XX000', message: 'boom' } }],
      })
      primePgDb(pg)
      const pgRes = await POST(createSettingsRequest({ channelPointRewardId: 'reward-1' }))

      expect(pgRes.status).toBe(postgrestRes.status)
      expect(pgRes.status).toBe(500)
      const pgBody = await pgRes.json()
      expect(pgBody).toEqual(await postgrestRes.json())
      expect(pgBody).toEqual({ error: 'Database error' })
    })

    it('rarity_weights_scope 列が未デプロイ: 両経路とも200 + flag一致（残りのフィールドは保存継続）', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock([
        { data: STREAMER_ROW },
        { error: missingColumnError('rarity_weights_scope') },
        { error: undefined },
      ])
      mockGetSupabaseAdmin.mockReturnValue(client as any)
      const postgrestRes = await POST(
        createSettingsRequest({ rarityWeightsScope: 'per_pack', channelPointRewardId: 'reward-1' })
      )
      const postgrestBody = await postgrestRes.json()

      vi.stubEnv('DB_DRIVER', 'pg')
      const pg = createDrizzleDbMock({
        selects: [{ rows: [STREAMER_ROW] }],
        updates: [{ error: missingColumnError('rarity_weights_scope') }, {}],
      })
      primePgDb(pg)
      const pgRes = await POST(
        createSettingsRequest({ rarityWeightsScope: 'per_pack', channelPointRewardId: 'reward-1' })
      )
      const pgBody = await pgRes.json()

      expect(pgRes.status).toBe(postgrestRes.status)
      expect(pgRes.status).toBe(200)
      expect(pgBody).toEqual(postgrestBody)
      expect(pgBody).toEqual({ success: true, recalculatedCards: null, rarityWeightsScopeSkippedDeployWindow: true })

      // 2回目の UPDATE 呼び出しでは rarity_weights_scope が落ちていること
      expect(pg.updateCalls).toHaveLength(2)
      expect(pg.updateCalls[1].set).toEqual({ channel_point_reward_id: 'reward-1' })
    })

    it('gacha_sound_rules 列が未デプロイ: 両経路とも200 + 旧来ミラー列からの復元エコー', async () => {
      const gachaSoundRules = [
        {
          id: 'catch-all',
          url: 'https://example.com/a.mp3',
          enabled: true,
          label: 'A',
          targetType: 'all',
          rarity: null,
          rewardId: null,
          rewardName: null,
        },
      ]

      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock([
        { data: STREAMER_ROW },
        { error: missingColumnError('gacha_sound_rules') },
        { error: undefined },
      ])
      mockGetSupabaseAdmin.mockReturnValue(client as any)
      const postgrestRes = await POST(createSettingsRequest({ gachaSoundRules }))
      const postgrestBody = await postgrestRes.json()

      vi.stubEnv('DB_DRIVER', 'pg')
      const pg = createDrizzleDbMock({
        selects: [{ rows: [STREAMER_ROW] }],
        updates: [{ error: missingColumnError('gacha_sound_rules') }, {}],
      })
      primePgDb(pg)
      const pgRes = await POST(createSettingsRequest({ gachaSoundRules }))
      const pgBody = await pgRes.json()

      expect(pgRes.status).toBe(postgrestRes.status)
      expect(pgRes.status).toBe(200)
      expect(pgBody).toEqual(postgrestBody)
      expect(pgBody.gachaSoundRulesSkippedDeployWindow).toBe(true)
      expect(pgBody.gachaSoundRules).toEqual(legacySoundToRules('https://example.com/a.mp3', true))

      // フォールバック後の2回目の UPDATE には gacha_sound_rules 列を含まない
      expect(pg.updateCalls).toHaveLength(2)
      expect(pg.updateCalls[1].set).toEqual({
        gacha_sound_url: 'https://example.com/a.mp3',
        gacha_sound_enabled: true,
      })
    })
  })

  describe('disconnectBot（streamer_chat_sender_settings upsert + twitch_bot_accounts DELETE）', () => {
    it('成功時: 両経路とも200 + upsert/delete の書き込み値が一致する', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock([
        { data: STREAMER_ROW },
        { error: undefined }, // upsert
        { error: undefined }, // delete
      ])
      mockGetSupabaseAdmin.mockReturnValue(client as any)
      const postgrestRes = await POST(createSettingsRequest({ disconnectBot: true }))
      const postgrestBody = await postgrestRes.json()

      vi.stubEnv('DB_DRIVER', 'pg')
      const pg = createDrizzleDbMock({
        selects: [{ rows: [STREAMER_ROW] }],
        upserts: [{}],
        deletes: [{}],
      })
      primePgDb(pg)
      const pgRes = await POST(createSettingsRequest({ disconnectBot: true }))
      const pgBody = await pgRes.json()

      expect(pgRes.status).toBe(postgrestRes.status)
      expect(pgRes.status).toBe(200)
      expect(pgBody).toEqual(postgrestBody)
      expect(pgBody).toEqual({ success: true, recalculatedCards: null })

      // 主 UPDATE は走らない(updateData が空 かつ botDisconnected=true のため)
      expect(pg.updateCalls).toHaveLength(0)

      expect(pg.upsertCalls).toHaveLength(1)
      expect(pg.upsertCalls[0].table).toBe(streamerChatSenderSettingsTable)
      expect(pg.upsertCalls[0].values).toEqual({
        streamer_id: 'streamer123',
        sender_mode: 'streamer',
        custom_bot_account_id: null,
      })
      expect(pg.upsertCalls[0].target).toBe(streamerChatSenderSettingsTable.streamer_id)

      expect(pg.deleteCalls).toHaveLength(1)
      expect(pg.deleteCalls[0].table).toBe(twitchBotAccountsTable)
    })

    it('sender settings upsert 失敗: 両経路とも500 + 同一body（DELETEは実行されない）', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock([{ data: STREAMER_ROW }, { error: { message: 'boom' } }])
      mockGetSupabaseAdmin.mockReturnValue(client as any)
      const postgrestRes = await POST(createSettingsRequest({ disconnectBot: true }))

      vi.stubEnv('DB_DRIVER', 'pg')
      const pg = createDrizzleDbMock({
        selects: [{ rows: [STREAMER_ROW] }],
        upserts: [{ error: { code: 'XX000', message: 'boom' } }],
      })
      primePgDb(pg)
      const pgRes = await POST(createSettingsRequest({ disconnectBot: true }))

      expect(pgRes.status).toBe(postgrestRes.status)
      expect(pgRes.status).toBe(500)
      expect(await pgRes.json()).toEqual(await postgrestRes.json())
      expect(pg.deleteCalls).toHaveLength(0)
    })

    it('twitch_bot_accounts DELETE 失敗: 両経路とも500 + 同一body', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock([
        { data: STREAMER_ROW },
        { error: undefined }, // upsert succeeds
        { error: { message: 'boom' } }, // delete fails
      ])
      mockGetSupabaseAdmin.mockReturnValue(client as any)
      const postgrestRes = await POST(createSettingsRequest({ disconnectBot: true }))

      vi.stubEnv('DB_DRIVER', 'pg')
      const pg = createDrizzleDbMock({
        selects: [{ rows: [STREAMER_ROW] }],
        upserts: [{}],
        deletes: [{ error: { code: 'XX000', message: 'boom' } }],
      })
      primePgDb(pg)
      const pgRes = await POST(createSettingsRequest({ disconnectBot: true }))

      expect(pgRes.status).toBe(postgrestRes.status)
      expect(pgRes.status).toBe(500)
      expect(await pgRes.json()).toEqual(await postgrestRes.json())
    })
  })

  describe('フラグ制御（挙動不変の検証）', () => {
    it('フラグ未設定時は getDb が一切呼ばれない', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock([{ data: STREAMER_ROW }, { error: undefined }])
      mockGetSupabaseAdmin.mockReturnValue(client as any)

      await POST(createSettingsRequest({ channelPointRewardId: 'reward-1' }))
      expect(getDb).not.toHaveBeenCalled()
    })

    it('DB_DRIVER=pg-read では読み書き混在ハンドラのため postgrest 経路のまま（getDb 不使用）', async () => {
      vi.stubEnv('DB_DRIVER', 'pg-read')
      const client = createSupabaseClientMock([{ data: STREAMER_ROW }, { error: undefined }])
      mockGetSupabaseAdmin.mockReturnValue(client as any)

      const res = await POST(createSettingsRequest({ channelPointRewardId: 'reward-1' }))
      expect(res.status).toBe(200)
      expect(getDb).not.toHaveBeenCalled()
    })

    it('未認証: 両経路とも401（フラグに依らず同一）、getDb は呼ばれない', async () => {
      mockGetSession.mockResolvedValue(null)
      for (const driver of [undefined, 'pg']) {
        vi.stubEnv('DB_DRIVER', driver)
        const res = await POST(createSettingsRequest({ channelPointRewardId: 'reward-1' }))
        expect(res.status).toBe(401)
      }
      expect(getDb).not.toHaveBeenCalled()
    })
  })
})
