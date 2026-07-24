/**
 * #572: token-manager の postgrest 経路 / pg 経路の互換テスト
 *
 * tests/unit/announcements-driver-parity.test.ts (#570 パイロット) と
 * tests/unit/dashboard-data-driver-parity.test.ts (#571) の流儀を踏襲する。
 * 読み取り関数は「同一 fixture で両経路の戻り値が deepEqual」、書き込み関数は
 * 「pg 経路で正しいテーブル・set 内容・where 条件で UPDATE され、戻り値が
 * postgrest 経路と一致する」ことを検証する。
 * フルスイートは実行せず、このファイル（と関連する変更分）のみを対象とする。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import {
  getTwitchAccessToken,
  getBotAccountForChat,
  getCustomBotAccountDisplayForStreamer,
  saveTwitchTokens,
  deleteTwitchTokens,
  hasScope,
  removeScope,
  saveTwitchScopes,
} from '@/lib/twitch/token-manager'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { refreshTwitchToken, TwitchTokenRefreshError } from '@/lib/twitch/auth'
import { getDb } from '@/lib/db/client'
import {
  twitchBotAccounts as twitchBotAccountsTable,
  users as usersTable,
} from '@/lib/db/schema'

// 自動モックは Error subclass の constructor を vi.fn に置換し、status を失わせる。
// token-manager は 4xx/5xx の恒久性を `TwitchTokenRefreshError.status` で判定するため、
// 実クラスを保持したまま、外部 I/O を行う refresh 関数だけを差し替える。
vi.mock('@/lib/twitch/auth', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/twitch/auth')>()
  return { ...actual, refreshTwitchToken: vi.fn() }
})
// logger.error は実装だと Supabase errors パイプラインへ fire-and-forget するため、
// テストでは副作用のないモックに差し替える（dashboard-data-driver-parity と同じ）
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// ---------------------------------------------------------------------------
// postgrest 経路のモック: from(table) ごとの結果キューを順に消費する thenable builder。
// select 系（maybeSingle）と書き込み系（update().eq() を await / .select().single()）
// の両チェーンに対応し、update に渡された値を記録して pg 経路の set 内容と比較できる
// ようにする。
// ---------------------------------------------------------------------------

interface PostgrestResult {
  data?: unknown
  error?: unknown
  reject?: unknown
}

function createSupabaseClientMock(resultsByTable: Record<string, PostgrestResult[]>) {
  const queues = Object.fromEntries(
    Object.entries(resultsByTable).map(([table, results]) => [table, [...results]])
  )
  const updateCalls: Array<{ table: string; values: Record<string, unknown> }> = []
  const updateFilterCalls: Array<{
    table: string
    filters: Array<{ column: string; value: unknown }>
  }> = []
  const from = vi.fn((table: string) => {
    const queue = queues[table]
    if (!queue || queue.length === 0) {
      throw new Error(`no mock result configured for table: ${table}`)
    }
    const result = queue.length > 1 ? (queue.shift() as PostgrestResult) : queue[0]
    const resolved = { data: result.data ?? null, error: result.error ?? null }
    const resolve = () => result.reject === undefined
      ? Promise.resolve(resolved)
      : Promise.reject(result.reject)
    let activeUpdateFilters: Array<{ column: string; value: unknown }> | null = null
    const builder: any = {
      select: vi.fn(() => builder),
      eq: vi.fn((column: string, value: unknown) => {
        // CASの安全性はUPDATEのID条件と旧refresh token条件の両方に依存する。
        // 読み取りチェーンのeqは混ぜず、update()後のfilterだけを記録する。
        activeUpdateFilters?.push({ column, value })
        return builder
      }),
      order: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      update: vi.fn((values: Record<string, unknown>) => {
        updateCalls.push({ table, values })
        activeUpdateFilters = []
        updateFilterCalls.push({ table, filters: activeUpdateFilters })
        return builder
      }),
      maybeSingle: vi.fn(resolve),
      single: vi.fn(resolve),
      then: (onFulfilled: any, onRejected: any) =>
        resolve().then(onFulfilled, onRejected),
    }
    return builder
  })
  return { from, updateCalls, updateFilterCalls }
}

// ---------------------------------------------------------------------------
// pg 経路のモック: select は fields のキーで射影した行を返し（実装が列を選び忘れると
// 形状差でテストが落ちる）、update は table / set / where / returning を記録する。
// builder は thenable（withDbRetry が queryFn の戻り値をそのまま await する）。
// ---------------------------------------------------------------------------

interface PgResponse {
  rows?: Array<Record<string, unknown>>
  error?: unknown
}

interface PgUpdateCall {
  table: unknown
  set?: Record<string, unknown>
  where?: unknown
  returningSelection?: Record<string, unknown>
}

function createDrizzleDbMock(config: {
  selects?: PgResponse[]
  updates?: PgResponse[]
} = {}) {
  let selectIndex = 0
  let updateIndex = 0
  const updateCalls: PgUpdateCall[] = []

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
        orderBy: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
    update: vi.fn((table: unknown) => {
      const responses = config.updates ?? [{ rows: [{}] }]
      const response = responses[Math.min(updateIndex, responses.length - 1)]
      updateIndex += 1
      const call: PgUpdateCall = { table }
      updateCalls.push(call)
      const resolve = () =>
        response.error ? Promise.reject(response.error) : Promise.resolve(response.rows ?? [])
      const builder: any = {
        set: vi.fn((values: Record<string, unknown>) => {
          call.set = values
          return builder
        }),
        where: vi.fn((condition: unknown) => {
          call.where = condition
          return builder
        }),
        returning: vi.fn((selection: Record<string, unknown>) => {
          call.returningSelection = selection
          return resolve()
        }),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
  }
  return { db, updateCalls }
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any)
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

const FUTURE_ISO = new Date(Date.now() + 3600_000).toISOString()
const PAST_ISO = new Date(Date.now() - 3600_000).toISOString()

const VALID_USER_TOKEN_ROW = {
  twitch_access_token: 'valid-token',
  twitch_refresh_token: 'refresh-token',
  twitch_token_expires_at: FUTURE_ISO,
}

const REFRESHED_TOKENS = {
  access_token: 'new-token',
  refresh_token: 'new-refresh-token',
  expires_in: 3600,
  token_type: 'bearer',
  scope: ['user:read:email'],
}

describe('token-manager: postgrest / pg 経路の互換 (#572)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('getTwitchAccessToken（読み取り: isPgReadEnabled）', () => {
    it('有効なトークン: 両経路が同じ値を返し、pg 経路では書き込みが発生しない', async () => {
      // postgrest 経路
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock({
        users: [{ data: VALID_USER_TOKEN_ROW }],
      })
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
      const postgrestResult = await getTwitchAccessToken('123456789')

      // pg 経路
      vi.stubEnv('DB_DRIVER', 'pg-read')
      const pg = createDrizzleDbMock({ selects: [{ rows: [VALID_USER_TOKEN_ROW] }] })
      primePgDb(pg)
      const pgResult = await getTwitchAccessToken('123456789')

      expect(pgResult).toBe(postgrestResult)
      expect(pgResult).toBe('valid-token')
      expect(pg.db.update).not.toHaveBeenCalled()
    })

    it('行なし: 両経路とも null を返す', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock({ users: [{ data: null }] })
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
      const postgrestResult = await getTwitchAccessToken('123456789')

      vi.stubEnv('DB_DRIVER', 'pg-read')
      const pg = createDrizzleDbMock({ selects: [{ rows: [] }] })
      primePgDb(pg)
      const pgResult = await getTwitchAccessToken('123456789')

      expect(postgrestResult).toBeNull()
      expect(pgResult).toBeNull()
    })

    it('列欠落(42703)のデプロイ窓では null を返す（PGRST204 相当のフォールバック）', async () => {
      vi.stubEnv('DB_DRIVER', 'pg-read')
      const pg = createDrizzleDbMock({
        selects: [{ error: { code: '42703', message: 'column "twitch_access_token" does not exist' } }],
      })
      primePgDb(pg)
      await expect(getTwitchAccessToken('123456789')).resolves.toBeNull()
    })

    it('DB_DRIVER=pg: tokenとscopeを同じCAS UPDATEで保存し、無条件の後続scope UPDATEを行わない', async () => {
      vi.stubEnv('DB_DRIVER', 'pg')
      vi.mocked(refreshTwitchToken).mockResolvedValue(REFRESHED_TOKENS)
      const pg = createDrizzleDbMock({
        selects: [{ rows: [{ ...VALID_USER_TOKEN_ROW, twitch_token_expires_at: PAST_ISO }] }],
      })
      primePgDb(pg)

      const token = await getTwitchAccessToken('123456789')

      expect(token).toBe('new-token')
      // OAuth callback の新しい scope を古い refresh 処理が後から上書きしないよう、
      // token と scope は旧 refresh token 条件付きの1回の UPDATE にまとめる。
      expect(pg.updateCalls).toHaveLength(1)
      expect(pg.updateCalls[0].table).toBe(usersTable)
      expect(pg.updateCalls[0].set).toEqual({
        twitch_access_token: 'new-token',
        twitch_refresh_token: 'new-refresh-token',
        twitch_token_expires_at: expect.any(String),
        twitch_scopes: ['user:read:email'],
      })
      expect(pg.updateCalls[0].where).toEqual(and(
        eq(usersTable.twitch_user_id, '123456789'),
        eq(usersTable.twitch_refresh_token, 'refresh-token'),
      ))
    })

    it('同一userの2並行refreshは2回交換し、CAS loserもwinner tokenを返して後続UPDATEしない', async () => {
      vi.stubEnv('DB_DRIVER', 'pg')
      const loserTokens = {
        ...REFRESHED_TOKENS,
        access_token: 'loser-access-token',
        refresh_token: 'loser-refresh-token',
        scope: ['loser:scope'],
      }
      const winnerTokens = {
        ...REFRESHED_TOKENS,
        access_token: 'winner-access-token',
        refresh_token: 'winner-refresh-token',
        scope: ['winner:scope'],
      }
      vi.mocked(refreshTwitchToken)
        .mockResolvedValueOnce(winnerTokens)
        .mockResolvedValueOnce(loserTokens)
      const pg = createDrizzleDbMock({
        selects: [
          { rows: [{ ...VALID_USER_TOKEN_ROW, twitch_token_expires_at: PAST_ISO }] },
          { rows: [{ ...VALID_USER_TOKEN_ROW, twitch_token_expires_at: PAST_ISO }] },
          { rows: [{ twitch_access_token: 'winner-access-token' }] },
        ],
        updates: [
          { rows: [{ twitch_access_token: 'winner-access-token' }] },
          { rows: [] },
        ],
      })
      primePgDb(pg)

      const results = await Promise.all([
        getTwitchAccessToken('123456789'),
        getTwitchAccessToken('123456789'),
      ])

      expect(refreshTwitchToken).toHaveBeenCalledTimes(2)
      expect(results).toEqual(['winner-access-token', 'winner-access-token'])
      expect(pg.updateCalls).toHaveLength(2)
      expect(pg.updateCalls[0].set).toMatchObject({
        twitch_access_token: 'winner-access-token',
        twitch_refresh_token: 'winner-refresh-token',
        twitch_scopes: ['winner:scope'],
      })
      for (const call of pg.updateCalls) {
        // loser の書込み試行も同じ旧 refresh token を条件とするため、winner が
        // rotation を保存した後は0件となり、資格情報もscopeも上書きできない。
        expect(call.where).toEqual(and(
          eq(usersTable.twitch_user_id, '123456789'),
          eq(usersTable.twitch_refresh_token, 'refresh-token'),
        ))
      }
      expect(pg.updateCalls[1].set).toMatchObject({
        twitch_access_token: 'loser-access-token',
        twitch_refresh_token: 'loser-refresh-token',
        twitch_scopes: ['loser:scope'],
      })
      // CAS後にscopeだけを無条件保存する3回目のUPDATEが無いことが、
      // callbackが保存した新scopeとのinterleaving回帰を構造的に防ぐ。
      expect(pg.updateCalls).toHaveLength(2)
    })

    it('PostgRESTでもCAS loserはwinnerのaccess tokenを再読込する', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      vi.mocked(refreshTwitchToken).mockResolvedValue({ ...REFRESHED_TOKENS, scope: [] })
      const client = createSupabaseClientMock({
        users: [
          { data: { ...VALID_USER_TOKEN_ROW, twitch_token_expires_at: PAST_ISO } },
          { data: null },
          { data: { twitch_access_token: 'postgrest-winner-token' } },
        ],
      })
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)

      await expect(getTwitchAccessToken('123456789')).resolves.toBe('postgrest-winner-token')
      expect(client.updateCalls).toHaveLength(1)
      expect(client.updateFilterCalls).toEqual([{
        table: 'users',
        filters: [
          { column: 'twitch_user_id', value: '123456789' },
          { column: 'twitch_refresh_token', value: 'refresh-token' },
        ],
      }])
    })

    it('DB_DRIVER=pg-read: 読み取りは pg・期限切れ時のトークン保存は postgrest のまま（フラグ使い分けの検証）', async () => {
      vi.stubEnv('DB_DRIVER', 'pg-read')
      vi.mocked(refreshTwitchToken).mockResolvedValue({ ...REFRESHED_TOKENS, scope: [] })
      // pg-read の refresh 保存は PostgREST CAS の更新結果を返す。
      const client = createSupabaseClientMock({
        users: [{ data: { twitch_access_token: 'new-token' } }],
      })
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
      const pg = createDrizzleDbMock({
        selects: [{ rows: [{ ...VALID_USER_TOKEN_ROW, twitch_token_expires_at: PAST_ISO }] }],
      })
      primePgDb(pg)

      const token = await getTwitchAccessToken('123456789')

      expect(token).toBe('new-token')
      // pg-read の書込みもtoken/scopeを同じPostgREST CASへまとめる。
      expect(client.updateCalls).toHaveLength(1)
      expect(client.updateCalls[0]).toEqual({
        table: 'users',
        values: {
          twitch_access_token: 'new-token',
          twitch_refresh_token: 'new-refresh-token',
          twitch_token_expires_at: expect.any(String),
          twitch_scopes: [],
        },
      })
      expect(client.updateFilterCalls).toEqual([{
        table: 'users',
        filters: [
          { column: 'twitch_user_id', value: '123456789' },
          { column: 'twitch_refresh_token', value: 'refresh-token' },
        ],
      }])
      // pg 側では update が呼ばれない
      expect(pg.updateCalls).toHaveLength(0)
    })

    it('フラグ未設定時は getDb が一切呼ばれない（挙動不変の検証）', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock({ users: [{ data: VALID_USER_TOKEN_ROW }] })
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
      await getTwitchAccessToken('123456789')
      expect(getDb).not.toHaveBeenCalled()
    })
  })

  describe('saveTwitchTokens / deleteTwitchTokens（書き込み: isPgWriteEnabled）', () => {
    const TOKENS = {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
      token_type: 'bearer',
      scope: ['user:read:email'],
    }

    it('saveTwitchTokens: 両経路とも resolve し、set 内容が一致する', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock({ users: [{ data: null }] })
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
      await expect(saveTwitchTokens('123456789', TOKENS)).resolves.toBeUndefined()

      vi.stubEnv('DB_DRIVER', 'pg')
      const pg = createDrizzleDbMock()
      primePgDb(pg)
      await expect(saveTwitchTokens('123456789', TOKENS)).resolves.toBeUndefined()

      expect(pg.updateCalls[0].table).toBe(usersTable)
      expect(pg.updateCalls[0].where).toEqual(eq(usersTable.twitch_user_id, '123456789'))
      // set のキー・値（expires_at は実行時刻依存のため個別比較）が postgrest 経路の
      // update 引数と一致する
      const postgrestValues = client.updateCalls[0].values
      const pgValues = pg.updateCalls[0].set as Record<string, unknown>
      expect(Object.keys(pgValues).sort()).toEqual(Object.keys(postgrestValues).sort())
      expect(pgValues.twitch_access_token).toBe(postgrestValues.twitch_access_token)
      expect(pgValues.twitch_refresh_token).toBe(postgrestValues.twitch_refresh_token)
      expect(typeof pgValues.twitch_token_expires_at).toBe('string')
    })

    it('saveTwitchTokens: 列欠落(42703)は throw せず return（PGRST204 相当）、それ以外は throw', async () => {
      vi.stubEnv('DB_DRIVER', 'pg')
      const missing = createDrizzleDbMock({
        updates: [{ error: { code: '42703', message: 'column "twitch_access_token" does not exist' } }],
      })
      primePgDb(missing)
      await expect(saveTwitchTokens('123456789', TOKENS)).resolves.toBeUndefined()

      const failing = createDrizzleDbMock({
        updates: [{ error: { code: '42601', message: 'syntax error' } }],
      })
      primePgDb(failing)
      await expect(saveTwitchTokens('123456789', TOKENS)).rejects.toEqual(
        { code: '42601', message: 'syntax error' }
      )
    })

    it('deleteTwitchTokens: pg 経路で 3 列とも null の set / 正しい where で UPDATE される', async () => {
      vi.stubEnv('DB_DRIVER', 'pg')
      const pg = createDrizzleDbMock()
      primePgDb(pg)
      await expect(deleteTwitchTokens('123456789')).resolves.toBeUndefined()

      expect(pg.updateCalls[0].table).toBe(usersTable)
      expect(pg.updateCalls[0].set).toEqual({
        twitch_access_token: null,
        twitch_refresh_token: null,
        twitch_token_expires_at: null,
      })
      expect(pg.updateCalls[0].where).toEqual(eq(usersTable.twitch_user_id, '123456789'))
    })
  })

  describe('hasScope（読み取り: isPgReadEnabled）', () => {
    it('スコープ保持/非保持/ユーザー不在で両経路の結果が一致する', async () => {
      const cases: Array<{ row: Record<string, unknown> | null; expected: boolean }> = [
        { row: { twitch_scopes: ['user:read:email', 'user:write:chat'] }, expected: true },
        { row: { twitch_scopes: ['user:read:email'] }, expected: false },
        { row: { twitch_scopes: null }, expected: false },
        { row: null, expected: false },
      ]

      for (const { row, expected } of cases) {
        vi.stubEnv('DB_DRIVER', undefined)
        const client = createSupabaseClientMock({ users: [{ data: row }] })
        vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
        const postgrestResult = await hasScope('123456789', 'user:write:chat')

        vi.stubEnv('DB_DRIVER', 'pg-read')
        const pg = createDrizzleDbMock({ selects: [{ rows: row ? [row] : [] }] })
        primePgDb(pg)
        const pgResult = await hasScope('123456789', 'user:write:chat')

        expect(pgResult).toBe(postgrestResult)
        expect(pgResult).toBe(expected)
      }
    })
  })

  describe('removeScope / saveTwitchScopes（書き込み: isPgWriteEnabled）', () => {
    it('removeScope: pg 経路で除外後の配列が set され、postgrest 経路の update 引数と一致する', async () => {
      const scopes = ['user:read:email', 'channel:read:redemptions', 'user:write:chat']

      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock({ users: [{ data: { twitch_scopes: scopes } }] })
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
      await removeScope('123456789', 'user:write:chat')

      vi.stubEnv('DB_DRIVER', 'pg')
      const pg = createDrizzleDbMock({ selects: [{ rows: [{ twitch_scopes: scopes }] }] })
      primePgDb(pg)
      await removeScope('123456789', 'user:write:chat')

      expect(pg.updateCalls).toHaveLength(1)
      expect(pg.updateCalls[0].table).toBe(usersTable)
      expect(pg.updateCalls[0].set).toEqual(client.updateCalls[0].values)
      expect(pg.updateCalls[0].set).toEqual({
        twitch_scopes: ['user:read:email', 'channel:read:redemptions'],
      })
      expect(pg.updateCalls[0].where).toEqual(eq(usersTable.twitch_user_id, '123456789'))
    })

    it('removeScope: スコープ未保持なら pg 経路でも UPDATE しない', async () => {
      vi.stubEnv('DB_DRIVER', 'pg')
      const pg = createDrizzleDbMock({
        selects: [{ rows: [{ twitch_scopes: ['user:read:email'] }] }],
      })
      primePgDb(pg)
      await removeScope('123456789', 'user:write:chat')
      expect(pg.updateCalls).toHaveLength(0)
    })

    it('saveTwitchScopes: pg 経路で全置換の set / where が正しく、DB エラー時は両経路とも throw する', async () => {
      const scopes = ['user:read:email', 'user:write:chat']

      vi.stubEnv('DB_DRIVER', 'pg')
      const pg = createDrizzleDbMock()
      primePgDb(pg)
      await expect(saveTwitchScopes('123456789', scopes)).resolves.toBeUndefined()
      expect(pg.updateCalls[0].table).toBe(usersTable)
      expect(pg.updateCalls[0].set).toEqual({ twitch_scopes: scopes })
      expect(pg.updateCalls[0].where).toEqual(eq(usersTable.twitch_user_id, '123456789'))

      const failing = createDrizzleDbMock({
        updates: [{ error: { code: '42601', message: 'syntax error' } }],
      })
      primePgDb(failing)
      await expect(saveTwitchScopes('123456789', scopes)).rejects.toEqual(
        { code: '42601', message: 'syntax error' }
      )
    })
  })

  describe('getBotAccountForChat（読み書き混在: isPgWriteEnabled で関数全体を分岐）', () => {
    const STREAMER_ROW = { id: 'streamer-1' }
    const SETTINGS_CUSTOM = { sender_mode: 'custom_bot', custom_bot_account_id: 'bot-account-1' }
    const BOT_ROW = {
      id: 'bot-account-1',
      owner_type: 'streamer',
      twitch_user_id: 'bot-twitch-1',
      twitch_username: 'bot_user',
      twitch_display_name: 'Bot User',
      twitch_access_token: 'bot-access-token',
      twitch_refresh_token: 'bot-refresh-token',
      twitch_token_expires_at: FUTURE_ISO,
    }

    it('DB_DRIVER=pg-read では書き込み混在関数のため postgrest 経路のまま（getDb 不使用）', async () => {
      vi.stubEnv('DB_DRIVER', 'pg-read')
      const client = createSupabaseClientMock({
        streamers: [{ data: STREAMER_ROW }],
        streamer_chat_sender_settings: [{ data: SETTINGS_CUSTOM }],
        twitch_bot_accounts: [{ data: BOT_ROW }],
      })
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)

      const result = await getBotAccountForChat('broadcaster-1')

      expect(result?.accessToken).toBe('bot-access-token')
      expect(getDb).not.toHaveBeenCalled()
    })

    it('custom_bot・期限内: 同一 fixture で両経路の戻り値が deepEqual になり、UPDATE は発生しない', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock({
        streamers: [{ data: STREAMER_ROW }],
        streamer_chat_sender_settings: [{ data: SETTINGS_CUSTOM }],
        twitch_bot_accounts: [{ data: BOT_ROW }],
      })
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
      const postgrestResult = await getBotAccountForChat('broadcaster-1')

      vi.stubEnv('DB_DRIVER', 'pg')
      const pg = createDrizzleDbMock({
        selects: [{ rows: [STREAMER_ROW] }, { rows: [SETTINGS_CUSTOM] }, { rows: [BOT_ROW] }],
      })
      primePgDb(pg)
      const pgResult = await getBotAccountForChat('broadcaster-1')

      expect(pgResult).toEqual(postgrestResult)
      expect(pgResult).toEqual({
        accountId: 'bot-account-1',
        senderId: 'bot-twitch-1',
        username: 'bot_user',
        displayName: 'Bot User',
        accessToken: 'bot-access-token',
        ownerType: 'streamer',
      })
      expect(pg.updateCalls).toHaveLength(0)
    })

    it('期限切れ: pg 経路でリフレッシュ結果が twitch_bot_accounts へ正しい set/where で保存される', async () => {
      vi.stubEnv('DB_DRIVER', 'pg')
      vi.mocked(refreshTwitchToken).mockResolvedValue(REFRESHED_TOKENS)
      const pg = createDrizzleDbMock({
        selects: [
          { rows: [STREAMER_ROW] },
          { rows: [SETTINGS_CUSTOM] },
          { rows: [{ ...BOT_ROW, twitch_token_expires_at: PAST_ISO }] },
        ],
      })
      primePgDb(pg)

      const result = await getBotAccountForChat('broadcaster-1')

      expect(result?.accessToken).toBe('new-token')
      expect(pg.updateCalls).toHaveLength(1)
      expect(pg.updateCalls[0].table).toBe(twitchBotAccountsTable)
      expect(pg.updateCalls[0].set).toEqual({
        twitch_access_token: 'new-token',
        twitch_refresh_token: 'new-refresh-token',
        twitch_token_expires_at: expect.any(String),
        scopes: ['user:read:email'],
        status: 'active',
        last_error: null,
      })
      expect(pg.updateCalls[0].where).toEqual(and(
        eq(twitchBotAccountsTable.id, 'bot-account-1'),
        eq(twitchBotAccountsTable.twitch_refresh_token, 'bot-refresh-token'),
      ))
    })

    it('同一BOTの2並行refreshは2回交換し、CAS loserもwinner tokenを返して上書きしない', async () => {
      vi.stubEnv('DB_DRIVER', 'pg')
      const loserTokens = {
        ...REFRESHED_TOKENS,
        access_token: 'loser-bot-access-token',
        refresh_token: 'loser-bot-refresh-token',
        scope: ['loser:bot-scope'],
      }
      const winnerTokens = {
        ...REFRESHED_TOKENS,
        access_token: 'winner-bot-token',
        refresh_token: 'winner-bot-refresh-token',
        scope: ['winner:bot-scope'],
      }
      vi.mocked(refreshTwitchToken)
        .mockResolvedValueOnce(winnerTokens)
        .mockResolvedValueOnce(loserTokens)
      const expiredBot = { ...BOT_ROW, twitch_token_expires_at: PAST_ISO }
      const pg = createDrizzleDbMock({
        selects: [
          { rows: [STREAMER_ROW] },
          { rows: [STREAMER_ROW] },
          { rows: [SETTINGS_CUSTOM] },
          { rows: [SETTINGS_CUSTOM] },
          { rows: [expiredBot] },
          { rows: [expiredBot] },
          { rows: [{ twitch_access_token: 'winner-bot-token' }] },
        ],
        updates: [
          { rows: [{ twitch_access_token: 'winner-bot-token' }] },
          { rows: [] },
        ],
      })
      primePgDb(pg)

      const results = await Promise.all([
        getBotAccountForChat('broadcaster-1'),
        getBotAccountForChat('broadcaster-2'),
      ])

      expect(refreshTwitchToken).toHaveBeenCalledTimes(2)
      expect(results.map(result => result?.accessToken)).toEqual([
        'winner-bot-token',
        'winner-bot-token',
      ])
      expect(pg.updateCalls).toHaveLength(2)
      expect(pg.updateCalls[0].set).toMatchObject({
        twitch_access_token: 'winner-bot-token',
        twitch_refresh_token: 'winner-bot-refresh-token',
        scopes: ['winner:bot-scope'],
      })
      for (const call of pg.updateCalls) {
        expect(call.where).toEqual(and(
          eq(twitchBotAccountsTable.id, 'bot-account-1'),
          eq(twitchBotAccountsTable.twitch_refresh_token, 'bot-refresh-token'),
        ))
      }
      expect(pg.updateCalls[1].set).toMatchObject({
        twitch_access_token: 'loser-bot-access-token',
        twitch_refresh_token: 'loser-bot-refresh-token',
        scopes: ['loser:bot-scope'],
      })
    })

    it('PostgRESTでもBOTのCAS loserはwinnerのaccess tokenを再読込する', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      vi.mocked(refreshTwitchToken).mockResolvedValue(REFRESHED_TOKENS)
      const expiredBot = { ...BOT_ROW, twitch_token_expires_at: PAST_ISO }
      const client = createSupabaseClientMock({
        streamers: [{ data: STREAMER_ROW }],
        streamer_chat_sender_settings: [{ data: SETTINGS_CUSTOM }],
        twitch_bot_accounts: [
          { data: expiredBot },
          { data: null },
          { data: { twitch_access_token: 'postgrest-winner-bot-token' } },
        ],
      })
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)

      await expect(getBotAccountForChat('broadcaster-1')).resolves.toMatchObject({
        accessToken: 'postgrest-winner-bot-token',
      })
      expect(client.updateCalls).toHaveLength(1)
      expect(client.updateFilterCalls).toEqual([{
        table: 'twitch_bot_accounts',
        filters: [
          { column: 'id', value: 'bot-account-1' },
          { column: 'twitch_refresh_token', value: 'bot-refresh-token' },
        ],
      }])
    })

    it('BOTの一時的522失敗はactiveを維持し、次の呼び出しで回復する', async () => {
      vi.stubEnv('DB_DRIVER', 'pg')
      const expiredBot = { ...BOT_ROW, twitch_token_expires_at: PAST_ISO }
      vi.mocked(refreshTwitchToken).mockRejectedValueOnce(new TwitchTokenRefreshError(522))
      const firstPg = createDrizzleDbMock({
        selects: [
          { rows: [STREAMER_ROW] },
          { rows: [SETTINGS_CUSTOM] },
          { rows: [expiredBot] },
        ],
      })
      primePgDb(firstPg)

      await expect(getBotAccountForChat('broadcaster-1')).resolves.toBeNull()
      // transient失敗ではstatusを変更しないため、active filterから除外されない。
      expect(firstPg.updateCalls).toHaveLength(0)
      const { logger } = await import('@/lib/logger')
      expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain('gateway unavailable')

      vi.mocked(refreshTwitchToken).mockResolvedValueOnce(REFRESHED_TOKENS)
      const secondPg = createDrizzleDbMock({
        selects: [
          { rows: [STREAMER_ROW] },
          { rows: [SETTINGS_CUSTOM] },
          { rows: [expiredBot] },
        ],
      })
      primePgDb(secondPg)
      await expect(getBotAccountForChat('broadcaster-1')).resolves.toMatchObject({
        accessToken: 'new-token',
      })
      expect(refreshTwitchToken).toHaveBeenCalledTimes(2)
    })

    it.each([
      ['custom_bot', SETTINGS_CUSTOM],
      ['official_bot', { sender_mode: 'official_bot', custom_bot_account_id: null }],
    ])('PostgRESTの%sもnetwork失敗ではactiveを維持し、次回回復する', async (mode, settings) => {
      vi.stubEnv('DB_DRIVER', undefined)
      const expiredBot = {
        ...BOT_ROW,
        owner_type: mode === 'official_bot' ? 'system' : 'streamer',
        twitch_token_expires_at: PAST_ISO,
      }
      vi.mocked(refreshTwitchToken).mockRejectedValueOnce(new TwitchTokenRefreshError())
      const firstClient = createSupabaseClientMock({
        streamers: [{ data: STREAMER_ROW }],
        streamer_chat_sender_settings: [{ data: settings }],
        twitch_bot_accounts: [{ data: expiredBot }],
      })
      vi.mocked(getSupabaseAdmin).mockReturnValue(firstClient as any)

      await expect(getBotAccountForChat('broadcaster-1')).resolves.toBeNull()
      expect(firstClient.updateCalls).toHaveLength(0)

      vi.mocked(refreshTwitchToken).mockResolvedValueOnce(REFRESHED_TOKENS)
      const secondClient = createSupabaseClientMock({
        streamers: [{ data: STREAMER_ROW }],
        streamer_chat_sender_settings: [{ data: settings }],
        twitch_bot_accounts: [
          { data: expiredBot },
          { data: { twitch_access_token: 'new-token' } },
        ],
      })
      vi.mocked(getSupabaseAdmin).mockReturnValue(secondClient as any)

      await expect(getBotAccountForChat('broadcaster-1')).resolves.toMatchObject({
        accessToken: 'new-token',
      })
      expect(refreshTwitchToken).toHaveBeenCalledTimes(2)
    })

    it.each([400, 401])('資格情報失効status=%iだけはpg経路で status=error を保存する', async status => {
      vi.stubEnv('DB_DRIVER', 'pg')
      vi.mocked(refreshTwitchToken).mockRejectedValue(new TwitchTokenRefreshError(status))
      const pg = createDrizzleDbMock({
        selects: [
          { rows: [STREAMER_ROW] },
          { rows: [SETTINGS_CUSTOM] },
          { rows: [{ ...BOT_ROW, twitch_token_expires_at: PAST_ISO }] },
        ],
      })
      primePgDb(pg)

      const result = await getBotAccountForChat('broadcaster-1')

      expect(result).toBeNull()
      expect(pg.updateCalls).toHaveLength(1)
      expect(pg.updateCalls[0].table).toBe(twitchBotAccountsTable)
      expect(pg.updateCalls[0].set).toEqual({ status: 'error', last_error: 'token_refresh_failed' })
      expect(pg.updateCalls[0].where).toEqual(and(
        eq(twitchBotAccountsTable.id, 'bot-account-1'),
        eq(twitchBotAccountsTable.twitch_refresh_token, 'bot-refresh-token'),
      ))
    })

    it.each([400, 401])('資格情報失効status=%iだけはPostgRESTでも status=error を保存する', async status => {
      vi.stubEnv('DB_DRIVER', undefined)
      vi.mocked(refreshTwitchToken).mockRejectedValue(new TwitchTokenRefreshError(status))
      const client = createSupabaseClientMock({
        streamers: [{ data: STREAMER_ROW }],
        streamer_chat_sender_settings: [{ data: SETTINGS_CUSTOM }],
        twitch_bot_accounts: [
          { data: { ...BOT_ROW, twitch_token_expires_at: PAST_ISO } },
          { data: null },
        ],
      })
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)

      await expect(getBotAccountForChat('broadcaster-1')).resolves.toBeNull()
      expect(client.updateCalls).toEqual([{
        table: 'twitch_bot_accounts',
        values: { status: 'error', last_error: 'token_refresh_failed' },
      }])
      // 先行refresh/callbackが資格情報を更新済みならactiveをerrorへ戻さない。
      // 恒久エラー状態の保存にもIDと交換時点の旧refresh tokenを必須にする。
      expect(client.updateFilterCalls).toEqual([{
        table: 'twitch_bot_accounts',
        filters: [
          { column: 'id', value: 'bot-account-1' },
          { column: 'twitch_refresh_token', value: 'bot-refresh-token' },
        ],
      }])
    })

    it.each([
      ['pg', 403],
      ['pg', 404],
      ['pg', 501],
      ['postgrest', 403],
      ['postgrest', 404],
      ['postgrest', 501],
    ])('%s経路のstatus=%iは資格情報失効と断定せずactiveを維持する', async (driver, status) => {
      vi.mocked(refreshTwitchToken).mockRejectedValue(new TwitchTokenRefreshError(status))
      const expiredBot = { ...BOT_ROW, twitch_token_expires_at: PAST_ISO }

      if (driver === 'pg') {
        vi.stubEnv('DB_DRIVER', 'pg')
        const pg = createDrizzleDbMock({
          selects: [
            { rows: [STREAMER_ROW] },
            { rows: [SETTINGS_CUSTOM] },
            { rows: [expiredBot] },
          ],
        })
        primePgDb(pg)
        await expect(getBotAccountForChat('broadcaster-1')).resolves.toBeNull()
        expect(pg.updateCalls).toHaveLength(0)
      } else {
        vi.stubEnv('DB_DRIVER', undefined)
        const client = createSupabaseClientMock({
          streamers: [{ data: STREAMER_ROW }],
          streamer_chat_sender_settings: [{ data: SETTINGS_CUSTOM }],
          twitch_bot_accounts: [{ data: expiredBot }],
        })
        vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
        await expect(getBotAccountForChat('broadcaster-1')).resolves.toBeNull()
        expect(client.updateCalls).toHaveLength(0)
      }
    })

    it('PostgRESTの恒久エラー状態保存がtransport rejectしてもnullへ縮退する', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      vi.mocked(refreshTwitchToken).mockRejectedValue(new TwitchTokenRefreshError(401))
      const client = createSupabaseClientMock({
        streamers: [{ data: STREAMER_ROW }],
        streamer_chat_sender_settings: [{ data: SETTINGS_CUSTOM }],
        twitch_bot_accounts: [
          { data: { ...BOT_ROW, twitch_token_expires_at: PAST_ISO } },
          { reject: new Error('status update transport failed') },
        ],
      })
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)

      await expect(getBotAccountForChat('broadcaster-1')).resolves.toBeNull()
      expect(client.updateCalls).toEqual([{
        table: 'twitch_bot_accounts',
        values: { status: 'error', last_error: 'token_refresh_failed' },
      }])
    })

    it('sender_mode=streamer / 設定なし: 両経路とも null（BOT スキーマ未デプロイ窓 42P01 も null）', async () => {
      vi.stubEnv('DB_DRIVER', 'pg')
      const noSettings = createDrizzleDbMock({
        selects: [{ rows: [STREAMER_ROW] }, { rows: [] }],
      })
      primePgDb(noSettings)
      await expect(getBotAccountForChat('broadcaster-1')).resolves.toBeNull()

      const missingTable = createDrizzleDbMock({
        selects: [
          { rows: [STREAMER_ROW] },
          { error: { code: '42P01', message: 'relation "streamer_chat_sender_settings" does not exist' } },
        ],
      })
      primePgDb(missingTable)
      await expect(getBotAccountForChat('broadcaster-1')).resolves.toBeNull()
    })
  })

  describe('getCustomBotAccountDisplayForStreamer（読み取り: isPgReadEnabled）', () => {
    it('同一 fixture で両経路の戻り値が deepEqual になる', async () => {
      const settings = { sender_mode: 'custom_bot', custom_bot_account_id: 'bot-account-1' }
      const display = { twitch_username: 'bot_user', twitch_display_name: 'Bot User' }

      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock({
        streamer_chat_sender_settings: [{ data: settings }],
        twitch_bot_accounts: [{ data: display }],
      })
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
      const postgrestResult = await getCustomBotAccountDisplayForStreamer('streamer-1')

      vi.stubEnv('DB_DRIVER', 'pg-read')
      const pg = createDrizzleDbMock({ selects: [{ rows: [settings] }, { rows: [display] }] })
      primePgDb(pg)
      const pgResult = await getCustomBotAccountDisplayForStreamer('streamer-1')

      expect(pgResult).toEqual(postgrestResult)
      expect(pgResult).toEqual({ username: 'bot_user', displayName: 'Bot User' })
    })
  })
})
