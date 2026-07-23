/**
 * #788 子B #790: src/lib/twitch/channel-points-access.ts (users テーブルへの
 * Channel Points Capability / opt-in 状態の永続化データレイヤ) の
 * postgrest 経路 / pg 直結経路 ドライバパリティテスト。
 *
 * モックの流儀は既存の driver-parity テスト群を踏襲する:
 *   - Drizzle select/update ビルダーモック: tests/unit/additional-rewards-driver-parity.test.ts
 *     (createDrizzleDbMock) / tests/unit/streamer-settings-driver-parity.test.ts
 *   - 生 sql タグテンプレートモック(RPC呼び出し): tests/unit/gacha-rpc-driver-parity.test.ts
 *     / tests/unit/write-rpc-driver-parity.test.ts の createSqlMock
 *
 * isPgReadEnabled()/isPgWriteEnabled() 自体はモックせず、他の driver-parity
 * テストと同じく vi.stubEnv('DB_DRIVER', ...) で src/lib/db/flags.ts の実装
 * (process.env 参照)をそのまま経由させる。理由: フラグ判定ロジック自体の
 * 正しさ(pg-read は読み取りのみ有効化する等)も一緒に検証できるほうが、
 * isPgReadEnabled を直接モックするより実体に近い。
 *
 * withDbRetry (src/lib/db/retry.ts) もモックしない。エラーに retryable な
 * code(CONNECTION_CLOSED 等)を含めるかどうかでリトライの有無を制御できるため、
 * 「idempotent: true が渡されているか」は実際にリトライが起きることで間接的に
 * 検証する(gacha-rpc-driver-parity.test.ts 等の既存の踏襲パターン)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getDb } from '@/lib/db/client'
import { users as usersTable } from '@/lib/db/schema'
import { logger } from '@/lib/logger'
import { createMockQueryBuilder } from '../utils/supabase-mock'
import {
  getChannelPointsAccessState,
  persistChannelPointsCapability,
  recordChannelPointsApiFailure,
  enableChannelPointsStreamerAccess,
} from '@/lib/twitch/channel-points-access'
import type { DefinitiveCapabilityResult } from '@/lib/twitch/channel-points'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/supabase/admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/admin')>()
  return { ...actual, getSupabaseAdmin: vi.fn() }
})

const mockGetSupabaseAdmin = vi.mocked(getSupabaseAdmin)
const mockGetDb = vi.mocked(getDb)

const TWITCH_USER_ID = 'twitch-user-1'
// new Date().toISOString() の形式 (YYYY-MM-DDTHH:mm:ss.sssZ)
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const AVAILABLE_RESULT: DefinitiveCapabilityResult = {
  capability: 'available',
  reason: 'ok',
  httpStatus: 200,
  definitive: true,
}

/** postgres.js が throw するエラー(err.code に SQLSTATE/ドライバコード)を模す */
function pgError(message: string, code?: string): Error & { code?: string } {
  const error = new Error(message) as Error & { code?: string }
  if (code) error.code = code
  return error
}

interface PgResponse {
  rows?: Array<Record<string, unknown>>
  reject?: unknown
}

/**
 * db.select({...}).from(usersTable).where(...).limit(1) を模す Drizzle ビルダーモック。
 * additional-rewards-driver-parity.test.ts の createDrizzleDbMock と同じ流儀。
 */
function createSelectDbMock(responses: PgResponse[]) {
  let callIndex = 0
  const calls: Array<{ where?: unknown }> = []
  const select = vi.fn((fields: Record<string, unknown>) => {
    const response = responses[Math.min(callIndex, responses.length - 1)]
    callIndex += 1
    const call: { where?: unknown } = {}
    calls.push(call)
    const resolve = () =>
      response.reject !== undefined
        ? Promise.reject(response.reject)
        : Promise.resolve(
            (response.rows ?? []).map((row) =>
              Object.fromEntries(Object.keys(fields).map((key) => [key, row[key] ?? null]))
            )
          )
    const builder: any = {
      from: vi.fn(() => builder),
      where: vi.fn((condition: unknown) => {
        call.where = condition
        return builder
      }),
      limit: vi.fn(() => builder),
      then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
    }
    return builder
  })
  return { db: { select } as any, calls }
}

/** db.update(usersTable).set({...}).where(...) を模す Drizzle ビルダーモック */
function createUpdateDbMock(responses: PgResponse[]) {
  let callIndex = 0
  const calls: Array<{ table?: unknown; set?: unknown; where?: unknown }> = []
  const update = vi.fn((table: unknown) => {
    const response = responses[Math.min(callIndex, responses.length - 1)]
    callIndex += 1
    const call: { table?: unknown; set?: unknown; where?: unknown } = { table }
    calls.push(call)
    const resolve = () =>
      response.reject !== undefined ? Promise.reject(response.reject) : Promise.resolve(response.rows ?? [])
    const builder: any = {
      set: vi.fn((values: unknown) => {
        call.set = values
        return builder
      }),
      where: vi.fn((condition: unknown) => {
        call.where = condition
        return builder
      }),
      then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
    }
    return builder
  })
  return { db: { update } as any, calls }
}

/**
 * postgres.js の sql タグ呼び出し(sql`...${v}...`)を模したモック。
 * gacha-rpc-driver-parity.test.ts / write-rpc-driver-parity.test.ts の
 * createSqlMock と同じ流儀(呼び出しごとに responses を1つずつ消費)。
 */
function createSqlMock(responses: Array<{ rows?: unknown[]; reject?: unknown }>) {
  let callIndex = 0
  return vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    void strings
    void values
    const response = responses[Math.min(callIndex, responses.length - 1)]
    callIndex += 1
    return response.reject !== undefined ? Promise.reject(response.reject) : Promise.resolve(response.rows ?? [])
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  // 各 describe 内の vi.stubEnv('DB_DRIVER', ...) を確実に元へ戻す
  // (announcements-driver-parity.test.ts 等の既存パターンと同じ理由)
  vi.unstubAllEnvs()
})

// =============================================================================
// getChannelPointsAccessState
// =============================================================================
describe('getChannelPointsAccessState', () => {
  describe('postgrest 経路(DB_DRIVER未設定)', () => {
    it('行が見つかれば capability/checkedAt/enabled を正しくマッピングする', async () => {
      const queryBuilder = createMockQueryBuilder()
      ;(queryBuilder.maybeSingle as any).mockResolvedValue({
        data: {
          channel_points_capability: 'available',
          channel_points_capability_checked_at: '2026-07-01T00:00:00.000Z',
          channel_points_enabled: true,
        },
        error: null,
      })
      mockGetSupabaseAdmin.mockReturnValue({ from: vi.fn(() => queryBuilder) } as any)

      const result = await getChannelPointsAccessState(TWITCH_USER_ID)

      expect(result).toEqual({
        capability: 'available',
        checkedAt: '2026-07-01T00:00:00.000Z',
        enabled: true,
      })
      expect(queryBuilder.select).toHaveBeenCalledWith(
        'channel_points_capability, channel_points_capability_checked_at, channel_points_enabled'
      )
      expect(queryBuilder.eq).toHaveBeenCalledWith('twitch_user_id', TWITCH_USER_ID)
    })

    it('行が無ければ null を返す(maybeSingle: data=null)', async () => {
      const queryBuilder = createMockQueryBuilder()
      ;(queryBuilder.maybeSingle as any).mockResolvedValue({ data: null, error: null })
      mockGetSupabaseAdmin.mockReturnValue({ from: vi.fn(() => queryBuilder) } as any)

      const result = await getChannelPointsAccessState(TWITCH_USER_ID)

      expect(result).toBeNull()
    })

    it('クエリエラーは握りつぶさず throw する', async () => {
      const queryError = new Error('connection refused')
      const queryBuilder = createMockQueryBuilder()
      ;(queryBuilder.maybeSingle as any).mockResolvedValue({ data: null, error: queryError })
      mockGetSupabaseAdmin.mockReturnValue({ from: vi.fn(() => queryBuilder) } as any)

      await expect(getChannelPointsAccessState(TWITCH_USER_ID)).rejects.toBe(queryError)
    })

    it('capability が falsy(null)なら unknown にフォールバックする(防御的分岐)', async () => {
      const queryBuilder = createMockQueryBuilder()
      ;(queryBuilder.maybeSingle as any).mockResolvedValue({
        data: {
          channel_points_capability: null,
          channel_points_capability_checked_at: null,
          channel_points_enabled: false,
        },
        error: null,
      })
      mockGetSupabaseAdmin.mockReturnValue({ from: vi.fn(() => queryBuilder) } as any)

      const result = await getChannelPointsAccessState(TWITCH_USER_ID)

      expect(result?.capability).toBe('unknown')
    })

    // #788 子E #793 Fableレビュー Major-3: migration未適用のデプロイ窓では
    // throwせず、unknown/null/falseの安全な既定値を返す(呼び出し元を個別に保護しない)。
    //
    // 最終レビュー Major-A: SELECT/order/filterでの列欠落はPostgreSQLが42703を返し、
    // PGRST204はinsert/update payloadの列欠落専用（このgetXxxはSELECTのみを行う
    // 読み取り関数のため、本番で実際に発生するのは42703）。PGRST204のみを見ていると
    // 実際のデプロイ窓で保護されない（src/lib/collections/collection-existence.ts の
    // 既存コメント参照）。両方をテストする。
    it('42703(列未デプロイ、SELECT経路で実際に発生するコード)ではthrowせずデプロイ窓の既定値を返す', async () => {
      const queryBuilder = createMockQueryBuilder()
      ;(queryBuilder.maybeSingle as any).mockResolvedValue({
        data: null,
        error: { code: '42703', message: 'column "channel_points_capability" does not exist' },
      })
      mockGetSupabaseAdmin.mockReturnValue({ from: vi.fn(() => queryBuilder) } as any)

      const result = await getChannelPointsAccessState(TWITCH_USER_ID)

      expect(result).toEqual({ capability: 'unknown', checkedAt: null, enabled: false })
    })

    it('PGRST204(念のための多重防御)でもthrowせずデプロイ窓の既定値を返す', async () => {
      const queryBuilder = createMockQueryBuilder()
      ;(queryBuilder.maybeSingle as any).mockResolvedValue({
        data: null,
        error: { code: 'PGRST204', message: 'column not found' },
      })
      mockGetSupabaseAdmin.mockReturnValue({ from: vi.fn(() => queryBuilder) } as any)

      const result = await getChannelPointsAccessState(TWITCH_USER_ID)

      expect(result).toEqual({ capability: 'unknown', checkedAt: null, enabled: false })
    })
  })

  describe('pg 経路(DB_DRIVER=pg-read)', () => {
    beforeEach(() => {
      vi.stubEnv('DB_DRIVER', 'pg-read')
    })

    it('行が見つかれば capability/checkedAt/enabled を正しくマッピングする', async () => {
      const { db, calls } = createSelectDbMock([
        { rows: [{ capability: 'available', checkedAt: '2026-07-01T00:00:00.000Z', enabled: true }] },
      ])
      mockGetDb.mockResolvedValue({ db, sql: {} as any })

      const result = await getChannelPointsAccessState(TWITCH_USER_ID)

      expect(result).toEqual({
        capability: 'available',
        checkedAt: '2026-07-01T00:00:00.000Z',
        enabled: true,
      })
      expect(calls[0].where).toEqual(eq(usersTable.twitch_user_id, TWITCH_USER_ID))
    })

    it('行が無ければ null を返す(空配列)', async () => {
      const { db } = createSelectDbMock([{ rows: [] }])
      mockGetDb.mockResolvedValue({ db, sql: {} as any })

      const result = await getChannelPointsAccessState(TWITCH_USER_ID)

      expect(result).toBeNull()
    })

    it('クエリエラーは握りつぶさず throw する', async () => {
      const queryError = new Error('connection refused')
      const { db } = createSelectDbMock([{ reject: queryError }])
      mockGetDb.mockResolvedValue({ db, sql: {} as any })

      await expect(getChannelPointsAccessState(TWITCH_USER_ID)).rejects.toBe(queryError)
    })

    it('capability が falsy(null)なら unknown にフォールバックする(防御的分岐)', async () => {
      const { db } = createSelectDbMock([{ rows: [{ capability: null, checkedAt: null, enabled: false }] }])
      mockGetDb.mockResolvedValue({ db, sql: {} as any })

      const result = await getChannelPointsAccessState(TWITCH_USER_ID)

      expect(result?.capability).toBe('unknown')
    })

    // #788 子E #793 Fableレビュー Major-3: migration未適用のデプロイ窓(42703)では
    // throwせず、unknown/null/falseの安全な既定値を返す。
    it('42703(列未デプロイ)ではthrowせずデプロイ窓の既定値を返す', async () => {
      const { db } = createSelectDbMock([{ reject: pgError('column "channel_points_capability" does not exist', '42703') }])
      mockGetDb.mockResolvedValue({ db, sql: {} as any })

      const result = await getChannelPointsAccessState(TWITCH_USER_ID)

      expect(result).toEqual({ capability: 'unknown', checkedAt: null, enabled: false })
    })
  })
})

// =============================================================================
// persistChannelPointsCapability
// =============================================================================
describe('persistChannelPointsCapability', () => {
  describe('postgrest 経路(DB_DRIVER未設定)', () => {
    it('capability + checked_at(ISO文字列) を含むオブジェクトで update する', async () => {
      const queryBuilder = createMockQueryBuilder()
      mockGetSupabaseAdmin.mockReturnValue({ from: vi.fn(() => queryBuilder) } as any)

      await persistChannelPointsCapability(TWITCH_USER_ID, AVAILABLE_RESULT)

      expect(queryBuilder.update).toHaveBeenCalledTimes(1)
      const updateArg = (queryBuilder.update as any).mock.calls[0][0]
      expect(updateArg.channel_points_capability).toBe('available')
      expect(updateArg.channel_points_capability_checked_at).toMatch(ISO_TIMESTAMP_RE)
      expect(queryBuilder.eq).toHaveBeenCalledWith('twitch_user_id', TWITCH_USER_ID)
    })

    it('update がエラーを返したら throw する', async () => {
      const updateError = new Error('write failed')
      const queryBuilder = createMockQueryBuilder()
      // update()/eq() はどちらも既定で queryBuilder 自身を返すチェイン可能モック
      // (createMockQueryBuilder)なので、最終的な await の解決値を .then の
      // 上書きで直接コントロールする(additional-rewards-driver-parity.test.ts の
      // rewardsQuery.then 上書きパターンと同じ流儀)。
      ;(queryBuilder as any).then = (resolve: (v: unknown) => void) => {
        resolve({ error: updateError })
        return queryBuilder
      }
      mockGetSupabaseAdmin.mockReturnValue({ from: vi.fn(() => queryBuilder) } as any)

      await expect(persistChannelPointsCapability(TWITCH_USER_ID, AVAILABLE_RESULT)).rejects.toBe(updateError)
    })

    // 自動レビュー(claude[bot])指摘 Major-1: 読み取り側(getChannelPointsAccessState)
    // と対になるデプロイ窓フォールバックが書き込み側に無く、POST/PUT
    // /api/account/channel-points が列未デプロイの窓で500になっていた。
    it.each(['PGRST204', '42703'])(
      '%sではthrowせず、保存をスキップして正常終了する(デプロイ窓フォールバック)',
      async (code) => {
        const queryBuilder = createMockQueryBuilder()
        ;(queryBuilder as any).then = (resolve: (v: unknown) => void) => {
          resolve({ error: { code, message: 'column not found' } })
          return queryBuilder
        }
        mockGetSupabaseAdmin.mockReturnValue({ from: vi.fn(() => queryBuilder) } as any)

        await expect(persistChannelPointsCapability(TWITCH_USER_ID, AVAILABLE_RESULT)).resolves.toBeUndefined()
      }
    )
  })

  describe('pg 経路(DB_DRIVER=pg)', () => {
    beforeEach(() => {
      vi.stubEnv('DB_DRIVER', 'pg')
    })

    it('update(usersTable).set({capability, checked_at}).where(...) が正しく呼ばれる', async () => {
      const { db, calls } = createUpdateDbMock([{ rows: [] }])
      mockGetDb.mockResolvedValue({ db, sql: {} as any })

      await persistChannelPointsCapability(TWITCH_USER_ID, AVAILABLE_RESULT)

      expect(calls).toHaveLength(1)
      expect(calls[0].table).toBe(usersTable)
      const setArg = calls[0].set as Record<string, unknown>
      expect(setArg.channel_points_capability).toBe('available')
      expect(setArg.channel_points_capability_checked_at).toMatch(ISO_TIMESTAMP_RE)
      expect(calls[0].where).toEqual(eq(usersTable.twitch_user_id, TWITCH_USER_ID))
    })

    it('idempotent:true — CONNECTION_CLOSED後にリトライして成功する(withDbRetryへidempotentが渡っている証跡)', async () => {
      // withDbRetry 自体はモックしていないため、「idempotent:true が渡された場合だけ
      // 起きるはずの挙動(retryable errorからの自動リトライ)」を実際に発生させることで
      // 間接的に検証する。idempotent:false(既定)なら1回で即throwし、この呼び出し回数
      // アサーションが失敗する。
      const { db, calls } = createUpdateDbMock([
        { reject: pgError('write CONNECTION_CLOSED', 'CONNECTION_CLOSED') },
        { rows: [] },
      ])
      mockGetDb.mockResolvedValue({ db, sql: {} as any })

      await expect(persistChannelPointsCapability(TWITCH_USER_ID, AVAILABLE_RESULT)).resolves.toBeUndefined()
      expect(calls).toHaveLength(2)
    })

    // 自動レビュー(claude[bot])指摘 Major-1: pg経路でも同様にデプロイ窓を吸収する。
    it('42703ではthrowせず、保存をスキップして正常終了する(デプロイ窓フォールバック)', async () => {
      const { db } = createUpdateDbMock([{ reject: pgError('column "channel_points_capability" does not exist', '42703') }])
      mockGetDb.mockResolvedValue({ db, sql: {} as any })

      await expect(persistChannelPointsCapability(TWITCH_USER_ID, AVAILABLE_RESULT)).resolves.toBeUndefined()
    })
  })
})

// =============================================================================
// recordChannelPointsApiFailure
// =============================================================================
describe('recordChannelPointsApiFailure', () => {
  it('401 → capability=reauth_required/reason=unauthorized を永続化する', async () => {
    const queryBuilder = createMockQueryBuilder()
    mockGetSupabaseAdmin.mockReturnValue({ from: vi.fn(() => queryBuilder) } as any)

    await recordChannelPointsApiFailure(TWITCH_USER_ID, 401)

    const updateArg = (queryBuilder.update as any).mock.calls[0][0]
    expect(updateArg.channel_points_capability).toBe('reauth_required')
  })

  it('403 → capability=unavailable/reason=forbidden を永続化する', async () => {
    const queryBuilder = createMockQueryBuilder()
    mockGetSupabaseAdmin.mockReturnValue({ from: vi.fn(() => queryBuilder) } as any)

    await recordChannelPointsApiFailure(TWITCH_USER_ID, 403)

    const updateArg = (queryBuilder.update as any).mock.calls[0][0]
    expect(updateArg.channel_points_capability).toBe('unavailable')
  })

  it('永続化(persistChannelPointsCapability)が失敗しても throw せず warn ログのみ残す', async () => {
    const persistError = new Error('db unreachable')
    const queryBuilder = createMockQueryBuilder()
    ;(queryBuilder as any).then = (resolve: (v: unknown) => void) => {
      resolve({ error: persistError })
      return queryBuilder
    }
    mockGetSupabaseAdmin.mockReturnValue({ from: vi.fn(() => queryBuilder) } as any)

    // reject せず正常に resolve すること自体が「throw しない」ことの証明
    await expect(recordChannelPointsApiFailure(TWITCH_USER_ID, 401)).resolves.toBeUndefined()
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      '[channel-points-access] recordChannelPointsApiFailure failed to persist',
      expect.objectContaining({ twitchUserId: TWITCH_USER_ID, httpStatus: 401, error: 'db unreachable' })
    )
  })
})

// =============================================================================
// enableChannelPointsStreamerAccess
// =============================================================================
describe('enableChannelPointsStreamerAccess', () => {
  describe('postgrest 経路(DB_DRIVER未設定)', () => {
    it('成功: rpc が返す streamer_id で ok:true になる', async () => {
      const rpc = vi.fn().mockResolvedValue({ data: 'uuid-postgrest-1', error: null })
      mockGetSupabaseAdmin.mockReturnValue({ rpc } as any)

      const result = await enableChannelPointsStreamerAccess(TWITCH_USER_ID)

      expect(result).toEqual({ ok: true, streamerId: 'uuid-postgrest-1' })
      expect(rpc).toHaveBeenCalledWith('enable_channel_points_streamer_access', {
        p_twitch_user_id: TWITCH_USER_ID,
      })
    })

    it('CAPABILITY_NOT_AVAILABLE エラー → ok:false, error:capability_not_available', async () => {
      const rpc = vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'CAPABILITY_NOT_AVAILABLE', code: 'P0001' },
      })
      mockGetSupabaseAdmin.mockReturnValue({ rpc } as any)

      const result = await enableChannelPointsStreamerAccess(TWITCH_USER_ID)

      expect(result).toEqual({ ok: false, error: 'capability_not_available' })
    })

    it('USER_NOT_FOUND エラー → ok:false, error:user_not_found', async () => {
      const rpc = vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'USER_NOT_FOUND', code: 'P0001' },
      })
      mockGetSupabaseAdmin.mockReturnValue({ rpc } as any)

      const result = await enableChannelPointsStreamerAccess(TWITCH_USER_ID)

      expect(result).toEqual({ ok: false, error: 'user_not_found' })
    })

    it('無関係なエラーは分類せず re-throw する(黙って握りつぶさない)', async () => {
      // DB関数は TWITCH_USER_ID_REQUIRED も RAISE EXCEPTION するが、これは
      // classifyEnableRpcError が拾わない第三のメッセージ(20260723150000_add_channel_points_capability.sql
      // 参照)。呼び出し元が独自にハンドリングすべき想定外エラーとして
      // そのまま伝播することを固定する。
      const unrelatedError = { message: 'TWITCH_USER_ID_REQUIRED', code: 'P0001' }
      const rpc = vi.fn().mockResolvedValue({ data: null, error: unrelatedError })
      mockGetSupabaseAdmin.mockReturnValue({ rpc } as any)

      await expect(enableChannelPointsStreamerAccess(TWITCH_USER_ID)).rejects.toEqual(unrelatedError)
    })
  })

  describe('pg 経路(DB_DRIVER=pg)', () => {
    beforeEach(() => {
      vi.stubEnv('DB_DRIVER', 'pg')
    })

    it('成功: sql が返す streamer_id で ok:true になる', async () => {
      const sqlMock = createSqlMock([{ rows: [{ streamer_id: 'uuid-pg-1' }] }])
      mockGetDb.mockResolvedValue({ db: {} as any, sql: sqlMock as any })

      const result = await enableChannelPointsStreamerAccess(TWITCH_USER_ID)

      expect(result).toEqual({ ok: true, streamerId: 'uuid-pg-1' })
      expect(sqlMock).toHaveBeenCalledTimes(1)
    })

    it('CAPABILITY_NOT_AVAILABLE (RAISE EXCEPTION文字列) → ok:false, error:capability_not_available', async () => {
      const sqlMock = createSqlMock([{ reject: pgError('CAPABILITY_NOT_AVAILABLE', 'P0001') }])
      mockGetDb.mockResolvedValue({ db: {} as any, sql: sqlMock as any })

      const result = await enableChannelPointsStreamerAccess(TWITCH_USER_ID)

      expect(result).toEqual({ ok: false, error: 'capability_not_available' })
    })

    it('USER_NOT_FOUND (RAISE EXCEPTION文字列) → ok:false, error:user_not_found', async () => {
      const sqlMock = createSqlMock([{ reject: pgError('USER_NOT_FOUND', 'P0001') }])
      mockGetDb.mockResolvedValue({ db: {} as any, sql: sqlMock as any })

      const result = await enableChannelPointsStreamerAccess(TWITCH_USER_ID)

      expect(result).toEqual({ ok: false, error: 'user_not_found' })
    })

    it('無関係なエラーは分類せず re-throw する(黙って握りつぶさない)', async () => {
      const unrelatedError = pgError('TWITCH_USER_ID_REQUIRED', 'P0001')
      const sqlMock = createSqlMock([{ reject: unrelatedError }])
      mockGetDb.mockResolvedValue({ db: {} as any, sql: sqlMock as any })

      await expect(enableChannelPointsStreamerAccess(TWITCH_USER_ID)).rejects.toThrow('TWITCH_USER_ID_REQUIRED')
    })

    it('streamer_id が null(行はある)なら「no streamer_id」エラーで throw する', async () => {
      const sqlMock = createSqlMock([{ rows: [{ streamer_id: null }] }])
      mockGetDb.mockResolvedValue({ db: {} as any, sql: sqlMock as any })

      await expect(enableChannelPointsStreamerAccess(TWITCH_USER_ID)).rejects.toThrow(
        'enable_channel_points_streamer_access returned no streamer_id'
      )
    })

    it('rows が空配列なら「no streamer_id」エラーで throw する', async () => {
      const sqlMock = createSqlMock([{ rows: [] }])
      mockGetDb.mockResolvedValue({ db: {} as any, sql: sqlMock as any })

      await expect(enableChannelPointsStreamerAccess(TWITCH_USER_ID)).rejects.toThrow(
        'enable_channel_points_streamer_access returned no streamer_id'
      )
    })

    it('冪等性: 同じ入力で2回呼んでも両方成功する(JS層で入力順序やstateに依存しないことの確認)', async () => {
      // DB側の真の冪等性(ON CONFLICT等)はモックでは検証できないため、ここでは
      // 「同一モックに対して2回呼んでも呼び出しごとに独立して同じ結果になる」
      // というJS層でのドキュメント的な確認に留める(タスク仕様の指示どおり)。
      const sqlMock = createSqlMock([{ rows: [{ streamer_id: 'uuid-pg-1' }] }])
      mockGetDb.mockResolvedValue({ db: {} as any, sql: sqlMock as any })

      const first = await enableChannelPointsStreamerAccess(TWITCH_USER_ID)
      const second = await enableChannelPointsStreamerAccess(TWITCH_USER_ID)

      expect(first).toEqual({ ok: true, streamerId: 'uuid-pg-1' })
      expect(second).toEqual({ ok: true, streamerId: 'uuid-pg-1' })
    })
  })

  // Fable厳格レビュー指摘(classifyEnableRpcErrorのコメント参照): PostgREST/pg直結
  // どちらの経路でも同一のRAISE EXCEPTION文字列から同一の型付きエラーへ写像
  // されることを、実際に両経路を実行して比較することで固定する。
  describe('driver parity: classifyEnableRpcError の分類結果が postgrest/pg で一致する', () => {
    it('CAPABILITY_NOT_AVAILABLE は両経路で同じ分類結果になる', async () => {
      const rpc = vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'CAPABILITY_NOT_AVAILABLE', code: 'P0001' },
      })
      mockGetSupabaseAdmin.mockReturnValue({ rpc } as any)
      const postgrestResult = await enableChannelPointsStreamerAccess(TWITCH_USER_ID)

      vi.stubEnv('DB_DRIVER', 'pg')
      const sqlMock = createSqlMock([{ reject: pgError('CAPABILITY_NOT_AVAILABLE', 'P0001') }])
      mockGetDb.mockResolvedValue({ db: {} as any, sql: sqlMock as any })
      const pgResult = await enableChannelPointsStreamerAccess(TWITCH_USER_ID)

      expect(pgResult).toEqual(postgrestResult)
      expect(pgResult).toEqual({ ok: false, error: 'capability_not_available' })
    })

    it('USER_NOT_FOUND は両経路で同じ分類結果になる', async () => {
      const rpc = vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'USER_NOT_FOUND', code: 'P0001' },
      })
      mockGetSupabaseAdmin.mockReturnValue({ rpc } as any)
      const postgrestResult = await enableChannelPointsStreamerAccess(TWITCH_USER_ID)

      vi.stubEnv('DB_DRIVER', 'pg')
      const sqlMock = createSqlMock([{ reject: pgError('USER_NOT_FOUND', 'P0001') }])
      mockGetDb.mockResolvedValue({ db: {} as any, sql: sqlMock as any })
      const pgResult = await enableChannelPointsStreamerAccess(TWITCH_USER_ID)

      expect(pgResult).toEqual(postgrestResult)
      expect(pgResult).toEqual({ ok: false, error: 'user_not_found' })
    })
  })
})
