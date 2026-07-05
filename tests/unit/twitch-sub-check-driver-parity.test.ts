/**
 * #572: sub-check (hasTwitchSub) の postgrest 経路 / pg 経路の互換テスト
 *
 * tests/unit/token-manager-driver-parity.test.ts と同じ流儀。
 * hasTwitchSub は読み取り（キャッシュ確認）と書き込み（キャッシュ更新 UPDATE 2 箇所）
 * が混在する関数のため、DB_DRIVER=pg のときのみ pg 経路に切り替わる
 * （pg-read では postgrest 経路のまま）ことも検証する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { hasTwitchSub } from '@/lib/twitch/sub-check'
import { getTwitchAccessToken } from '@/lib/twitch/token-manager'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getDb } from '@/lib/db/client'
import { logger } from '@/lib/logger'
import { users as usersTable } from '@/lib/db/schema'

vi.mock('@/lib/twitch/token-manager', () => ({
  getTwitchAccessToken: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const mockFetch = vi.fn()

// ---------------------------------------------------------------------------
// postgrest 経路のモック: select→eq→maybeSingle / update→eq→select→maybeSingle
// （既存 tests/unit/twitch-sub-check.test.ts の createQueryBuilder と同形式 +
//   update 引数の記録）
// ---------------------------------------------------------------------------

function createSupabaseClientMock(options: {
  selectData?: unknown
  updateData?: unknown
}) {
  const { selectData = null, updateData = { twitch_user_id: 'user-1' } } = options
  const updateCalls: Array<Record<string, unknown>> = []
  const queryBuilder = {
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        maybeSingle: vi.fn().mockResolvedValue({ data: selectData, error: null }),
      }),
    }),
    update: vi.fn((values: Record<string, unknown>) => {
      updateCalls.push(values)
      return {
        eq: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: updateData, error: null }),
          }),
        }),
      }
    }),
  }
  return { from: vi.fn(() => queryBuilder), updateCalls }
}

// ---------------------------------------------------------------------------
// pg 経路のモック（token-manager-driver-parity.test.ts と同方式）
// ---------------------------------------------------------------------------

interface PgUpdateCall {
  table: unknown
  set?: Record<string, unknown>
  where?: unknown
  returningSelection?: Record<string, unknown>
}

function createDrizzleDbMock(config: {
  selects?: Array<{ rows?: Array<Record<string, unknown>>; error?: unknown }>
  updates?: Array<{ rows?: Array<Record<string, unknown>>; error?: unknown }>
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
        limit: vi.fn(() => builder),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
    update: vi.fn((table: unknown) => {
      const responses = config.updates ?? [{ rows: [{ twitch_user_id: 'user-1' }] }]
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

const SUB_SCOPES = ['user:read:subscriptions']

/** キャッシュ有効（数分前に検証済み）のユーザー行 */
function freshUserRow(hasSub: boolean) {
  return {
    twitch_sub_verified_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    twitch_has_sub: hasSub,
    twitch_scopes: SUB_SCOPES,
  }
}

/** キャッシュ期限切れ（2時間前に検証）のユーザー行 */
function staleUserRow(hasSub: boolean) {
  return {
    twitch_sub_verified_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    twitch_has_sub: hasSub,
    twitch_scopes: SUB_SCOPES,
  }
}

describe('hasTwitchSub: postgrest / pg 経路の互換 (#572)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', mockFetch)
    // isTwitchSubCheckEnabled / checkTwitchSubViaApi が参照する環境変数
    vi.stubEnv('TWITCH_BROADCASTER_ID', 'broadcaster-123')
    vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    // fake timers を使うテストが失敗しても他テストへ漏れないよう必ず復元する
    vi.useRealTimers()
  })

  it('キャッシュ有効: 両経路とも前回結果を返し、pg 経路では UPDATE も Twitch API 呼び出しも発生しない', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({ selectData: freshUserRow(true) })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestResult = await hasTwitchSub('user-1')

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({ selects: [{ rows: [freshUserRow(true)] }] })
    primePgDb(pg)
    const pgResult = await hasTwitchSub('user-1')

    expect(pgResult).toBe(postgrestResult)
    expect(pgResult).toBe(true)
    expect(pg.updateCalls).toHaveLength(0)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('キャッシュ期限切れ + API 成功: pg 経路で users へ正しい set/where/returning の UPDATE が実行される', async () => {
    vi.stubEnv('DB_DRIVER', 'pg')
    // Twitch API: 200 = サブスク中
    mockFetch.mockResolvedValue({ ok: true, status: 200 })
    const pg = createDrizzleDbMock({ selects: [{ rows: [staleUserRow(false)] }] })
    primePgDb(pg)

    const result = await hasTwitchSub('user-1')

    expect(result).toBe(true)
    expect(pg.updateCalls).toHaveLength(1)
    expect(pg.updateCalls[0].table).toBe(usersTable)
    expect(pg.updateCalls[0].set).toEqual({
      twitch_sub_verified_at: expect.any(String),
      twitch_has_sub: true,
    })
    expect(pg.updateCalls[0].where).toEqual(eq(usersTable.twitch_user_id, 'user-1'))
    // 既存の .update().eq().select('twitch_user_id').maybeSingle() に対応する
    // returning 指定（マッチ 0 行検出のため）
    expect(pg.updateCalls[0].returningSelection).toEqual({
      twitch_user_id: usersTable.twitch_user_id,
    })
  })

  it('キャッシュ期限切れ + API 成功: 両経路の戻り値が一致する（404 = 非サブスクも含む）', async () => {
    // 両経路が書く twitch_sub_verified_at（実行時刻由来）をミリ秒単位まで一致させる
    // ため Date のみ固定する（setTimeout は fake にしない: withDbRetry のリトライ
    // 遅延等を巻き込まないため）
    vi.useFakeTimers({ toFake: ['Date'] })
    for (const { fetchResponse, expected } of [
      { fetchResponse: { ok: true, status: 200 }, expected: true },
      { fetchResponse: { ok: false, status: 404 }, expected: false },
    ]) {
      vi.stubEnv('DB_DRIVER', undefined)
      mockFetch.mockResolvedValue(fetchResponse)
      const client = createSupabaseClientMock({ selectData: staleUserRow(!expected) })
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
      const postgrestResult = await hasTwitchSub('user-1')

      vi.stubEnv('DB_DRIVER', 'pg')
      const pg = createDrizzleDbMock({ selects: [{ rows: [staleUserRow(!expected)] }] })
      primePgDb(pg)
      const pgResult = await hasTwitchSub('user-1')

      expect(pgResult).toBe(postgrestResult)
      expect(pgResult).toBe(expected)
      // set 内容も postgrest 経路の update 引数と一致する
      expect(pg.updateCalls[0].set).toEqual(client.updateCalls[0])
    }
    vi.useRealTimers()
  })

  it('API エラー時: pg 経路でタイムスタンプのみの UPDATE になり、前回値を返す（両経路一致）', async () => {
    // set 内容の突き合わせのため Date のみ固定（上のテストと同じ理由）
    vi.useFakeTimers({ toFake: ['Date'] })
    // 500 = API エラー（hasSub null）→ 短縮 TTL 用にタイムスタンプのみ更新
    mockFetch.mockResolvedValue({ ok: false, status: 500 })

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({ selectData: staleUserRow(true) })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestResult = await hasTwitchSub('user-1')

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({ selects: [{ rows: [staleUserRow(true)] }] })
    primePgDb(pg)
    const pgResult = await hasTwitchSub('user-1')

    expect(pgResult).toBe(postgrestResult)
    expect(pgResult).toBe(true) // twitch_has_sub の前回値を保持
    expect(pg.updateCalls).toHaveLength(1)
    expect(pg.updateCalls[0].set).toEqual({ twitch_sub_verified_at: expect.any(String) })
    expect(pg.updateCalls[0].set).toEqual(client.updateCalls[0])
    vi.useRealTimers()
  })

  it('キャッシュ更新の失敗（0 行更新 / DB エラー）はリクエスト継続に影響せず結果を返す', async () => {
    vi.stubEnv('DB_DRIVER', 'pg')
    mockFetch.mockResolvedValue({ ok: true, status: 200 })

    // 0 行更新（ユーザー削除等）
    const zeroRows = createDrizzleDbMock({
      selects: [{ rows: [staleUserRow(false)] }],
      updates: [{ rows: [] }],
    })
    primePgDb(zeroRows)
    await expect(hasTwitchSub('user-1')).resolves.toBe(true)
    expect(logger.error).toHaveBeenCalledWith(
      '[TwitchSub] Failed to update sub cache:',
      expect.objectContaining({ twitchUserId: 'user-1' })
    )

    // UPDATE 自体の失敗（throw）
    const failing = createDrizzleDbMock({
      selects: [{ rows: [staleUserRow(false)] }],
      updates: [{ error: { code: '42601', message: 'syntax error' } }],
    })
    primePgDb(failing)
    await expect(hasTwitchSub('user-1')).resolves.toBe(true)
  })

  it('スコープ未付与 / ユーザー不在: 両経路とも false', async () => {
    vi.stubEnv('DB_DRIVER', 'pg')
    const noScope = createDrizzleDbMock({
      selects: [{ rows: [{ ...freshUserRow(true), twitch_scopes: [] }] }],
    })
    primePgDb(noScope)
    await expect(hasTwitchSub('user-1')).resolves.toBe(false)

    const noUser = createDrizzleDbMock({ selects: [{ rows: [] }] })
    primePgDb(noUser)
    await expect(hasTwitchSub('user-1')).resolves.toBe(false)
  })

  it('DB_DRIVER=pg-read では書き込み混在関数のため postgrest 経路のまま（getDb 不使用）', async () => {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const client = createSupabaseClientMock({ selectData: freshUserRow(true) })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)

    await expect(hasTwitchSub('user-1')).resolves.toBe(true)
    expect(getDb).not.toHaveBeenCalled()
  })

  it('フラグ未設定時は getDb が一切呼ばれない（挙動不変の検証）', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({ selectData: freshUserRow(true) })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)

    await expect(hasTwitchSub('user-1')).resolves.toBe(true)
    expect(getDb).not.toHaveBeenCalled()
  })
})
