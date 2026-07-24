/**
 * #572: storage-db の PlanetScale/Drizzle 契約テスト
 *
 * tests/unit/token-manager-driver-parity.test.ts と同じ流儀。
 * - recordBlobFile / removeBlobFile の INSERT/DELETE と RPC 引数を検証する。
 * - getStorageBonusBytes / hasStorageBonusByTwitchUserId のJOIN条件と結果を検証する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { and, desc, eq, inArray } from 'drizzle-orm'
import {
  recordBlobFile,
  removeBlobFile,
  getStorageBonusBytes,
  hasStorageBonusByTwitchUserId,
  getStorageUsageFromDB,
  getAllStorageUsage,
} from '@/lib/storage-db'
import { getDb } from '@/lib/db/client'
import {
  blobFiles as blobFilesTable,
  streamers as streamersTable,
  streamerStorageBonus as streamerStorageBonusTable,
  storageUsage as storageUsageTable,
} from '@/lib/db/schema'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

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
  const selectCalls: Array<{ joins: Array<{ table: unknown; on: unknown }>; where?: unknown; orderBy?: unknown }> = []
  const insertCalls: Array<{ table: unknown; values?: Record<string, unknown> }> = []
  const deleteCalls: Array<{ table: unknown; where?: unknown }> = []

  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      const responses = config.selects ?? [{ rows: [] }]
      const response = responses[Math.min(selectIndex, responses.length - 1)]
      selectIndex += 1
      const call: { joins: Array<{ table: unknown; on: unknown }>; where?: unknown; orderBy?: unknown } = { joins: [] }
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
        orderBy: vi.fn((condition: unknown) => {
          call.orderBy = condition
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

describe('storage-db: PlanetScale 経路 (#572)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('recordBlobFile', () => {
    const ARGS = ['https://cdn.example/f.png', 'prefix12', 1234, 'r2'] as const

    it('blob_files へ正しい values を INSERT し、RPCを名前付き引数で呼ぶ', async () => {
      const pg = createDrizzleDbMock()
      primePgDb(pg)
      await expect(recordBlobFile(...ARGS)).resolves.toBeUndefined()

      expect(pg.insertCalls).toHaveLength(1)
      expect(pg.insertCalls[0].table).toBe(blobFilesTable)
      expect(pg.insertCalls[0].values).toEqual({
        url: 'https://cdn.example/f.png',
        user_prefix: 'prefix12',
        file_size: 1234,
        storage_type: 'r2',
      })
      // RPC: sql タグで select update_storage_usage(p_xxx => 値) の名前付き引数呼び出し
      expect(pg.sqlTag).toHaveBeenCalledTimes(1)
      const [strings, ...values] = pg.sqlTag.mock.calls[0] as [TemplateStringsArray, ...unknown[]]
      expect(strings.join('$')).toBe(
        'select update_storage_usage(p_user_prefix => $, p_size_delta => $, p_count_delta => $)'
      )
      expect(values).toEqual(['prefix12', 1234, 1])
    })

    it('INSERT 失敗: 両経路と同じ形の Error を throw し、RPC は呼ばれない', async () => {
      const pg = createDrizzleDbMock({
        inserts: [{ error: { code: '23505', message: 'duplicate key value' } }],
      })
      primePgDb(pg)

      await expect(recordBlobFile(...ARGS)).rejects.toThrow(/^Failed to record blob file: /)
      expect(pg.sqlTag).not.toHaveBeenCalled()
    })

    it('RPC 失敗: ログのみで throw しない（次回の計算で補正される。既存と同じ）', async () => {
      const pg = createDrizzleDbMock({ sqlError: { code: '42883', message: 'function does not exist' } })
      primePgDb(pg)

      await expect(recordBlobFile(...ARGS)).resolves.toBeUndefined()
      expect(pg.insertCalls).toHaveLength(1)
    })

  })

  describe('removeBlobFile', () => {
    const URL = 'https://cdn.example/f.png'
    const FILE_ROW = { user_prefix: 'prefix12', file_size: 1234, storage_type: 'r2' }

    it('該当ファイルあり: DELETE/RPC を実行し削除情報を返す', async () => {
      const pg = createDrizzleDbMock({ selects: [{ rows: [FILE_ROW] }] })
      primePgDb(pg)
      const pgResult = await removeBlobFile(URL)

      expect(pgResult).toEqual({ userPrefix: 'prefix12', fileSize: 1234, storageType: 'r2' })

      // DELETE: url（PK）指定
      expect(pg.deleteCalls).toHaveLength(1)
      expect(pg.deleteCalls[0].table).toBe(blobFilesTable)
      expect(pg.deleteCalls[0].where).toEqual(eq(blobFilesTable.url, URL))

      // RPC: 負の delta で使用量を減算する。
      const [strings, ...values] = pg.sqlTag.mock.calls[0] as [TemplateStringsArray, ...unknown[]]
      expect(strings.join('$')).toBe(
        'select update_storage_usage(p_user_prefix => $, p_size_delta => $, p_count_delta => $)'
      )
      expect(values).toEqual(['prefix12', -1234, -1])
    })

    it('該当ファイルなし: null を返し、DELETE / RPC は発生しない', async () => {
      const pg = createDrizzleDbMock({ selects: [{ rows: [] }] })
      primePgDb(pg)
      const pgResult = await removeBlobFile(URL)

      expect(pgResult).toBeNull()
      expect(pg.deleteCalls).toHaveLength(0)
      expect(pg.sqlTag).not.toHaveBeenCalled()
    })

    it('DELETE 失敗: throw し、RPC は呼ばれない（既存と同じ流れ）', async () => {
      const pg = createDrizzleDbMock({
        selects: [{ rows: [FILE_ROW] }],
        deletes: [{ error: { code: '42601', message: 'syntax error' } }],
      })
      primePgDb(pg)

      await expect(removeBlobFile(URL)).rejects.toThrow(/^Failed to delete blob file: /)
      expect(pg.sqlTag).not.toHaveBeenCalled()
    })
  })

  describe('getStorageBonusBytes', () => {
    it('ボーナスあり/なし/streamer 不在を正しく集計する', async () => {
      const cases: Array<{
        pgRows: Array<Record<string, unknown>>
        expected: number
      }> = [
        {
          // ボーナス 2 件（10MB + 5MB）
          pgRows: [{ amount_mb: 10 }, { amount_mb: 5 }],
          expected: 15 * 1024 * 1024,
        },
        {
          // streamer はいるがボーナス 0 件（LEFT JOIN 不一致の null 行）
          pgRows: [{ amount_mb: null }],
          expected: 0,
        },
        {
          // streamer 不在
          pgRows: [],
          expected: 0,
        },
      ]

      for (const { pgRows, expected } of cases) {
        const pg = createDrizzleDbMock({ selects: [{ rows: pgRows }] })
        primePgDb(pg)
        const result = await getStorageBonusBytes('twitch-user-1')

        expect(result).toBe(expected)
      }
    })

    it('pg 経路のクエリが FK リレーション相当の LEFT JOIN + twitch_user_id 条件で発行される', async () => {
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

  describe('hasStorageBonusByTwitchUserId', () => {
    it('適用済み/未適用を判定し、INNER JOIN 条件に type/memo を含む', async () => {
      for (const { pgRows, expected } of [
        { pgRows: [{ id: 'bonus-1' }], expected: true },
        { pgRows: [], expected: false },
      ]) {
        const pg = createDrizzleDbMock({ selects: [{ rows: pgRows }] })
        primePgDb(pg)
        const result = await hasStorageBonusByTwitchUserId('twitch-user-1', 'vote', 'campaign-2026')

        expect(result).toBe(expected)

        // type/memo をJOIN条件へ含め、対象ボーナスだけを絞り込む。
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

  describe('getStorageUsageFromDB (#663)', () => {
    const USER_PREFIX = 'prefix12'
    const GLOBAL_PREFIX = '_global_'

    it('userとglobal両方の行を集計する', async () => {
      const rows = [
        { user_prefix: USER_PREFIX, bytes_used: 1000 },
        { user_prefix: GLOBAL_PREFIX, bytes_used: 5000 },
      ]

      const pg = createDrizzleDbMock({ selects: [{ rows }] })
      primePgDb(pg)
      const result = await getStorageUsageFromDB(USER_PREFIX)

      expect(result).toEqual({
        userUsage: 1000,
        globalUsage: 5000,
        userLimitReached: false,
        globalLimitReached: false,
        userLimitBytes: result.userLimitBytes,
        globalLimitBytes: result.globalLimitBytes,
      })

      // pg 経路のクエリが user_prefix IN (userPrefix, GLOBAL_PREFIX) 相当で発行される
      expect(pg.selectCalls[0].where).toEqual(
        inArray(storageUsageTable.user_prefix, [USER_PREFIX, GLOBAL_PREFIX])
      )
    })

    it('該当行が無い場合は0を返す', async () => {
      const pg = createDrizzleDbMock({ selects: [{ rows: [] }] })
      primePgDb(pg)
      const result = await getStorageUsageFromDB(USER_PREFIX)

      expect(result.userUsage).toBe(0)
      expect(result.globalUsage).toBe(0)
    })

    it('pg 経路で取得エラー時は例外を投げず安全側のデフォルト値を返す（既存と同じ外部挙動）', async () => {
      const pg = createDrizzleDbMock({ selects: [{ error: { code: '08006', message: 'connection failure' } }] })
      primePgDb(pg)

      const result = await getStorageUsageFromDB(USER_PREFIX)

      expect(result).toEqual({
        userUsage: 0,
        globalUsage: 0,
        userLimitReached: false,
        globalLimitReached: false,
        userLimitBytes: result.userLimitBytes,
        globalLimitBytes: result.globalLimitBytes,
      })
    })
  })

  describe('getAllStorageUsage (#663)', () => {
    const ROWS = [
      { user_prefix: 'aaaaaaaa', bytes_used: 9000, blob_count: 3 },
      { user_prefix: 'bbbbbbbb', bytes_used: 1000, blob_count: 1 },
    ]

    it('bytes_used降順で返す', async () => {
      const pg = createDrizzleDbMock({ selects: [{ rows: ROWS }] })
      primePgDb(pg)
      const result = await getAllStorageUsage()

      expect(result).toEqual([
        { userPrefix: 'aaaaaaaa', bytesUsed: 9000, blobCount: 3 },
        { userPrefix: 'bbbbbbbb', bytesUsed: 1000, blobCount: 1 },
      ])

      // pg 経路のクエリが bytes_used 降順で発行される
      expect(pg.selectCalls[0].orderBy).toEqual(desc(storageUsageTable.bytes_used))
    })

    it('pg 経路で取得エラー時は throw する（既存と同じ外部挙動、デフォルト値へのフォールバックはしない）', async () => {
      const pg = createDrizzleDbMock({ selects: [{ error: { code: '08006', message: 'connection failure' } }] })
      primePgDb(pg)

      await expect(getAllStorageUsage()).rejects.toBeTruthy()
    })

  })
})
