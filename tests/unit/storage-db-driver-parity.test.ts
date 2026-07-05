/**
 * #572: storage-db の postgrest 経路 / pg 経路の互換テスト
 *
 * tests/unit/token-manager-driver-parity.test.ts と同じ流儀。
 * - recordBlobFile / removeBlobFile（書き込み: DB_DRIVER=pg のみ切替）は
 *   「正しいテーブル・values/where で INSERT/DELETE され、RPC update_storage_usage が
 *   sql タグの名前付き引数（p_xxx => 値）で呼ばれ、戻り値が postgrest 経路と一致する」
 *   ことを検証する。
 * - getStorageBonusBytes / hasStorageBonusByTwitchUserId（読み取り: pg-read で切替）は
 *   同一 fixture での戻り値一致を検証する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import {
  recordBlobFile,
  removeBlobFile,
  getStorageBonusBytes,
  hasStorageBonusByTwitchUserId,
} from '@/lib/storage-db'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getDb } from '@/lib/db/client'
import {
  blobFiles as blobFilesTable,
  streamers as streamersTable,
  streamerStorageBonus as streamerStorageBonusTable,
} from '@/lib/db/schema'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// ---------------------------------------------------------------------------
// postgrest 経路のモック: from(table) ごとの結果キュー + insert/delete/rpc の記録
// ---------------------------------------------------------------------------

interface PostgrestResult {
  data?: unknown
  error?: unknown
}

function createSupabaseClientMock(resultsByTable: Record<string, PostgrestResult[]>) {
  const queues = Object.fromEntries(
    Object.entries(resultsByTable).map(([table, results]) => [table, [...results]])
  )
  const insertCalls: Array<{ table: string; values: unknown }> = []
  const rpcCalls: Array<{ fn: string; args: unknown }> = []
  const from = vi.fn((table: string) => {
    const queue = queues[table]
    if (!queue || queue.length === 0) {
      throw new Error(`no mock result configured for table: ${table}`)
    }
    const result = queue.length > 1 ? (queue.shift() as PostgrestResult) : queue[0]
    const resolved = { data: result.data ?? null, error: result.error ?? null }
    const builder: any = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      in: vi.fn(() => builder),
      maybeSingle: vi.fn(() => Promise.resolve(resolved)),
      insert: vi.fn((values: unknown) => {
        insertCalls.push({ table, values })
        return builder
      }),
      delete: vi.fn(() => builder),
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve(resolved).then(onFulfilled, onRejected),
    }
    return builder
  })
  const rpc = vi.fn((fn: string, args: unknown) => {
    rpcCalls.push({ fn, args })
    return Promise.resolve({ error: null })
  })
  return { from, rpc, insertCalls, rpcCalls }
}

// ---------------------------------------------------------------------------
// pg 経路のモック: select（join/where 引数を記録）/ insert / delete と、
// RPC 用の sql タグ（テンプレート文字列と値を記録）
// ---------------------------------------------------------------------------

function createDrizzleDbMock(config: {
  selects?: Array<{ rows?: Array<Record<string, unknown>>; error?: unknown }>
  inserts?: Array<{ error?: unknown }>
  deletes?: Array<{ error?: unknown }>
  sqlError?: unknown
} = {}) {
  let selectIndex = 0
  let insertIndex = 0
  let deleteIndex = 0
  const selectCalls: Array<{ joins: Array<{ table: unknown; on: unknown }>; where?: unknown }> = []
  const insertCalls: Array<{ table: unknown; values?: Record<string, unknown> }> = []
  const deleteCalls: Array<{ table: unknown; where?: unknown }> = []

  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      const responses = config.selects ?? [{ rows: [] }]
      const response = responses[Math.min(selectIndex, responses.length - 1)]
      selectIndex += 1
      const call: { joins: Array<{ table: unknown; on: unknown }>; where?: unknown } = { joins: [] }
      selectCalls.push(call)
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
        leftJoin: vi.fn((table: unknown, on: unknown) => {
          call.joins.push({ table, on })
          return builder
        }),
        innerJoin: vi.fn((table: unknown, on: unknown) => {
          call.joins.push({ table, on })
          return builder
        }),
        where: vi.fn((condition: unknown) => {
          call.where = condition
          return builder
        }),
        limit: vi.fn(() => builder),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
    insert: vi.fn((table: unknown) => {
      const responses = config.inserts ?? [{}]
      const response = responses[Math.min(insertIndex, responses.length - 1)]
      insertIndex += 1
      const call: { table: unknown; values?: Record<string, unknown> } = { table }
      insertCalls.push(call)
      const resolve = () => (response.error ? Promise.reject(response.error) : Promise.resolve([]))
      const builder: any = {
        values: vi.fn((values: Record<string, unknown>) => {
          call.values = values
          return builder
        }),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
    delete: vi.fn((table: unknown) => {
      const responses = config.deletes ?? [{}]
      const response = responses[Math.min(deleteIndex, responses.length - 1)]
      deleteIndex += 1
      const call: { table: unknown; where?: unknown } = { table }
      deleteCalls.push(call)
      const resolve = () => (response.error ? Promise.reject(response.error) : Promise.resolve([]))
      const builder: any = {
        where: vi.fn((condition: unknown) => {
          call.where = condition
          return builder
        }),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
  }

  // postgres.js の sql タグ相当（sql`...` = sql(strings, ...values) 呼び出し。
  // 実引数は vi.fn の mock.calls に自動記録される。呼び出しシグネチャはジェネリクスで
  // 与え、実装側では未使用引数を持たない（eslint no-unused-vars 回避）
  const sqlTag = vi.fn<(...args: unknown[]) => Promise<unknown[]>>(() =>
    config.sqlError ? Promise.reject(config.sqlError) : Promise.resolve([])
  )

  return { db, sqlTag, selectCalls, insertCalls, deleteCalls }
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: mock.sqlTag } as any)
}

describe('storage-db: postgrest / pg 経路の互換 (#572)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('recordBlobFile（書き込み: isPgWriteEnabled）', () => {
    const ARGS = ['https://cdn.example/f.png', 'prefix12', 1234, 'r2'] as const

    it('pg 経路で blob_files へ正しい values の INSERT + RPC が名前付き引数で呼ばれ、両経路とも resolve する', async () => {
      // postgrest 経路
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock({ blob_files: [{ data: null }] })
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
      await expect(recordBlobFile(...ARGS)).resolves.toBeUndefined()
      expect(client.rpcCalls[0]).toEqual({
        fn: 'update_storage_usage',
        args: { p_user_prefix: 'prefix12', p_size_delta: 1234, p_count_delta: 1 },
      })

      // pg 経路
      vi.stubEnv('DB_DRIVER', 'pg')
      const pg = createDrizzleDbMock()
      primePgDb(pg)
      await expect(recordBlobFile(...ARGS)).resolves.toBeUndefined()

      // INSERT: テーブル・values が postgrest 経路の insert 引数と一致
      expect(pg.insertCalls).toHaveLength(1)
      expect(pg.insertCalls[0].table).toBe(blobFilesTable)
      expect(pg.insertCalls[0].values).toEqual({
        url: 'https://cdn.example/f.png',
        user_prefix: 'prefix12',
        file_size: 1234,
        storage_type: 'r2',
      })
      expect(pg.insertCalls[0].values).toEqual(client.insertCalls[0].values)

      // RPC: sql タグで select update_storage_usage(p_xxx => 値) の名前付き引数呼び出し
      expect(pg.sqlTag).toHaveBeenCalledTimes(1)
      const [strings, ...values] = pg.sqlTag.mock.calls[0] as [TemplateStringsArray, ...unknown[]]
      expect(strings.join('$')).toBe(
        'select update_storage_usage(p_user_prefix => $, p_size_delta => $, p_count_delta => $)'
      )
      expect(values).toEqual(['prefix12', 1234, 1])
    })

    it('INSERT 失敗: 両経路と同じ形の Error を throw し、RPC は呼ばれない', async () => {
      vi.stubEnv('DB_DRIVER', 'pg')
      const pg = createDrizzleDbMock({
        inserts: [{ error: { code: '23505', message: 'duplicate key value' } }],
      })
      primePgDb(pg)

      await expect(recordBlobFile(...ARGS)).rejects.toThrow(/^Failed to record blob file: /)
      expect(pg.sqlTag).not.toHaveBeenCalled()
    })

    it('RPC 失敗: ログのみで throw しない（次回の計算で補正される。既存と同じ）', async () => {
      vi.stubEnv('DB_DRIVER', 'pg')
      const pg = createDrizzleDbMock({ sqlError: { code: '42883', message: 'function does not exist' } })
      primePgDb(pg)

      await expect(recordBlobFile(...ARGS)).resolves.toBeUndefined()
      expect(pg.insertCalls).toHaveLength(1)
    })

    it('フラグ未設定 / pg-read では getDb が呼ばれない（書き込み関数のため pg-read でも postgrest のまま）', async () => {
      for (const driver of [undefined, 'pg-read']) {
        vi.stubEnv('DB_DRIVER', driver as string)
        const client = createSupabaseClientMock({ blob_files: [{ data: null }] })
        vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
        await expect(recordBlobFile(...ARGS)).resolves.toBeUndefined()
        expect(getDb).not.toHaveBeenCalled()
      }
    })
  })

  describe('removeBlobFile（読み書き混在: isPgWriteEnabled で関数全体を分岐）', () => {
    const URL = 'https://cdn.example/f.png'
    const FILE_ROW = { user_prefix: 'prefix12', file_size: 1234, storage_type: 'r2' }

    it('該当ファイルあり: 同一 fixture で両経路の戻り値が deepEqual になり、pg 経路の DELETE/RPC が正しい', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock({
        blob_files: [{ data: FILE_ROW }, { data: null }],
      })
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
      const postgrestResult = await removeBlobFile(URL)
      expect(client.rpcCalls[0]).toEqual({
        fn: 'update_storage_usage',
        args: { p_user_prefix: 'prefix12', p_size_delta: -1234, p_count_delta: -1 },
      })

      vi.stubEnv('DB_DRIVER', 'pg')
      const pg = createDrizzleDbMock({ selects: [{ rows: [FILE_ROW] }] })
      primePgDb(pg)
      const pgResult = await removeBlobFile(URL)

      expect(pgResult).toEqual(postgrestResult)
      expect(pgResult).toEqual({ userPrefix: 'prefix12', fileSize: 1234, storageType: 'r2' })

      // DELETE: url（PK）指定
      expect(pg.deleteCalls).toHaveLength(1)
      expect(pg.deleteCalls[0].table).toBe(blobFilesTable)
      expect(pg.deleteCalls[0].where).toEqual(eq(blobFilesTable.url, URL))

      // RPC: 負の delta での減算（postgrest 経路の rpc 引数と同じ値）
      const [strings, ...values] = pg.sqlTag.mock.calls[0] as [TemplateStringsArray, ...unknown[]]
      expect(strings.join('$')).toBe(
        'select update_storage_usage(p_user_prefix => $, p_size_delta => $, p_count_delta => $)'
      )
      expect(values).toEqual(['prefix12', -1234, -1])
    })

    it('該当ファイルなし: 両経路とも null を返し、DELETE / RPC は発生しない', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock({ blob_files: [{ data: null }] })
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
      const postgrestResult = await removeBlobFile(URL)

      vi.stubEnv('DB_DRIVER', 'pg')
      const pg = createDrizzleDbMock({ selects: [{ rows: [] }] })
      primePgDb(pg)
      const pgResult = await removeBlobFile(URL)

      expect(postgrestResult).toBeNull()
      expect(pgResult).toBeNull()
      expect(pg.deleteCalls).toHaveLength(0)
      expect(pg.sqlTag).not.toHaveBeenCalled()
    })

    it('DELETE 失敗: throw し、RPC は呼ばれない（既存と同じ流れ）', async () => {
      vi.stubEnv('DB_DRIVER', 'pg')
      const pg = createDrizzleDbMock({
        selects: [{ rows: [FILE_ROW] }],
        deletes: [{ error: { code: '42601', message: 'syntax error' } }],
      })
      primePgDb(pg)

      await expect(removeBlobFile(URL)).rejects.toThrow(/^Failed to delete blob file: /)
      expect(pg.sqlTag).not.toHaveBeenCalled()
    })
  })

  describe('getStorageBonusBytes（読み取り: isPgReadEnabled）', () => {
    it('ボーナスあり/なし/streamer 不在で両経路の結果が一致する', async () => {
      const cases: Array<{
        postgrestData: unknown
        pgRows: Array<Record<string, unknown>>
        expected: number
      }> = [
        {
          // ボーナス 2 件（10MB + 5MB）
          postgrestData: { streamer_storage_bonus: [{ amount_mb: 10 }, { amount_mb: 5 }] },
          pgRows: [{ amount_mb: 10 }, { amount_mb: 5 }],
          expected: 15 * 1024 * 1024,
        },
        {
          // streamer はいるがボーナス 0 件（pg は LEFT JOIN 不一致の null 行）
          postgrestData: { streamer_storage_bonus: [] },
          pgRows: [{ amount_mb: null }],
          expected: 0,
        },
        {
          // streamer 不在
          postgrestData: null,
          pgRows: [],
          expected: 0,
        },
      ]

      for (const { postgrestData, pgRows, expected } of cases) {
        vi.stubEnv('DB_DRIVER', undefined)
        const client = createSupabaseClientMock({ streamers: [{ data: postgrestData }] })
        vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
        const postgrestResult = await getStorageBonusBytes('twitch-user-1')

        vi.stubEnv('DB_DRIVER', 'pg-read')
        const pg = createDrizzleDbMock({ selects: [{ rows: pgRows }] })
        primePgDb(pg)
        const pgResult = await getStorageBonusBytes('twitch-user-1')

        expect(pgResult).toBe(postgrestResult)
        expect(pgResult).toBe(expected)
      }
    })

    it('pg 経路のクエリが FK リレーション相当の LEFT JOIN + twitch_user_id 条件で発行される', async () => {
      vi.stubEnv('DB_DRIVER', 'pg-read')
      const pg = createDrizzleDbMock({ selects: [{ rows: [{ amount_mb: 10 }] }] })
      primePgDb(pg)

      await getStorageBonusBytes('twitch-user-1')

      expect(pg.selectCalls[0].joins).toHaveLength(1)
      expect(pg.selectCalls[0].joins[0].table).toBe(streamerStorageBonusTable)
      expect(pg.selectCalls[0].joins[0].on).toEqual(
        eq(streamerStorageBonusTable.streamer_id, streamersTable.id)
      )
      expect(pg.selectCalls[0].where).toEqual(eq(streamersTable.twitch_user_id, 'twitch-user-1'))
    })
  })

  describe('hasStorageBonusByTwitchUserId（読み取り: isPgReadEnabled）', () => {
    it('適用済み/未適用で両経路の結果が一致し、pg 経路は INNER JOIN の結合条件に type/memo を含む', async () => {
      for (const { postgrestData, pgRows, expected } of [
        { postgrestData: { streamer_storage_bonus: [{ id: 'bonus-1' }] }, pgRows: [{ id: 'bonus-1' }], expected: true },
        { postgrestData: null, pgRows: [], expected: false },
      ]) {
        vi.stubEnv('DB_DRIVER', undefined)
        const client = createSupabaseClientMock({ streamers: [{ data: postgrestData }] })
        vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
        const postgrestResult = await hasStorageBonusByTwitchUserId('twitch-user-1', 'vote', 'campaign-2026')

        vi.stubEnv('DB_DRIVER', 'pg-read')
        const pg = createDrizzleDbMock({ selects: [{ rows: pgRows }] })
        primePgDb(pg)
        const pgResult = await hasStorageBonusByTwitchUserId('twitch-user-1', 'vote', 'campaign-2026')

        expect(pgResult).toBe(postgrestResult)
        expect(pgResult).toBe(expected)

        // PostgREST の !inner 埋め込み + 埋め込み列フィルタに対応する INNER JOIN 条件
        expect(pg.selectCalls[0].joins[0].on).toEqual(
          and(
            eq(streamerStorageBonusTable.streamer_id, streamersTable.id),
            eq(streamerStorageBonusTable.type, 'vote'),
            eq(streamerStorageBonusTable.memo, 'campaign-2026')
          )
        )
        expect(pg.selectCalls[0].where).toEqual(eq(streamersTable.twitch_user_id, 'twitch-user-1'))
      }
    })
  })
})
