/**
 * #663 (Batch A): checkCollectionHasActiveCards の postgrest 経路 / pg 経路の
 * 互換テスト。
 *
 * tests/unit/twitch-sub-check-driver-parity.test.ts と同じ流儀（同一 fixture を
 * 両経路に与えて戻り値・エラー系（schema-not-ready / 予期しないエラーの throw）を
 * 突き合わせる）。読み取り専用（COUNT のみ）のため isPgReadEnabled() で分岐する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import { checkCollectionHasActiveCards } from '@/lib/collections/collection-existence'
import { DEFAULT_PACK_SENTINEL } from '@/lib/validation/collection-name'
import { getDb } from '@/lib/db/client'
import { cards as cardsTable } from '@/lib/db/schema'

const STREAMER_ID = 'streamer-1'
const PACK_NAME = 'pack-a'

// ---------------------------------------------------------------------------
// postgrest 経路のモック: from("cards").select("id", {count,head}).eq().eq()
// [.eq()|.is()] のチェーンを thenable として await できるようにする
// ---------------------------------------------------------------------------

function createSupabaseClientMock(result: { count: number | null; error: { message?: string; code?: string } | null }) {
  const builder: any = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    is: vi.fn(() => builder),
    then: (onFulfilled: any, onRejected: any) => Promise.resolve(result).then(onFulfilled, onRejected),
  }
  return { from: vi.fn(() => builder), builder }
}

// ---------------------------------------------------------------------------
// pg 経路のモック
// ---------------------------------------------------------------------------

function createDrizzleDbMock(config: { rows?: Array<{ count: number }>; error?: unknown } = {}) {
  const selectCalls: Array<{ fields: Record<string, unknown>; where?: unknown }> = []
  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      const call = { fields } as { fields: Record<string, unknown>; where?: unknown }
      selectCalls.push(call)
      const resolve = () =>
        config.error ? Promise.reject(config.error) : Promise.resolve(config.rows ?? [{ count: 0 }])
      const builder: any = {
        from: vi.fn(() => builder),
        where: vi.fn((condition: unknown) => {
          call.where = condition
          return builder
        }),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
  }
  return { db, selectCalls }
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any)
}

describe('checkCollectionHasActiveCards（読み取り専用: DB_DRIVER=pg-read でも pg 経路）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('アクティブカードが1枚以上ある: 両経路とも "exists"', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({ count: 2, error: null })
    const postgrestResult = await checkCollectionHasActiveCards(client as any, STREAMER_ID, PACK_NAME)

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ rows: [{ count: 2 }] })
    primePgDb(pg)
    const pgResult = await checkCollectionHasActiveCards(client as any, STREAMER_ID, PACK_NAME)

    expect(pgResult).toBe(postgrestResult)
    expect(pgResult).toBe('exists')
  })

  it('アクティブカードが0枚: 両経路とも "absent"', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({ count: 0, error: null })
    const postgrestResult = await checkCollectionHasActiveCards(client as any, STREAMER_ID, PACK_NAME)

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ rows: [{ count: 0 }] })
    primePgDb(pg)
    const pgResult = await checkCollectionHasActiveCards(client as any, STREAMER_ID, PACK_NAME)

    expect(pgResult).toBe(postgrestResult)
    expect(pgResult).toBe('absent')
  })

  it('DEFAULT_PACK_SENTINEL: pg 経路は isNull(collection_name) を含む where 条件で問い合わせる', async () => {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ rows: [{ count: 1 }] })
    primePgDb(pg)

    const result = await checkCollectionHasActiveCards({} as any, STREAMER_ID, DEFAULT_PACK_SENTINEL)

    expect(result).toBe('exists')
    expect(pg.selectCalls).toHaveLength(1)
    expect(pg.selectCalls[0].where).toEqual(
      and(eq(cardsTable.streamer_id, STREAMER_ID), eq(cardsTable.is_active, true), isNull(cardsTable.collection_name))
    )
  })

  it('通常パック名: pg 経路は eq(collection_name, name) を含む where 条件で問い合わせる', async () => {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ rows: [{ count: 1 }] })
    primePgDb(pg)

    await checkCollectionHasActiveCards({} as any, STREAMER_ID, PACK_NAME)

    expect(pg.selectCalls[0].where).toEqual(
      and(
        eq(cardsTable.streamer_id, STREAMER_ID),
        eq(cardsTable.is_active, true),
        eq(cardsTable.collection_name, PACK_NAME)
      )
    )
  })

  it('collection_name 列未デプロイ: 両経路とも "schema-not-ready"', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({
      count: null,
      error: { code: 'PGRST204', message: "Could not find the 'collection_name' column" },
    })
    const postgrestResult = await checkCollectionHasActiveCards(client as any, STREAMER_ID, PACK_NAME)

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ error: { code: '42703', message: 'column "collection_name" does not exist' } })
    primePgDb(pg)
    const pgResult = await checkCollectionHasActiveCards(client as any, STREAMER_ID, PACK_NAME)

    expect(pgResult).toBe(postgrestResult)
    expect(pgResult).toBe('schema-not-ready')
  })

  it('予期しないエラー: 両経路とも throw する（空パックのまま保存成功させないフェイルクローズ）', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({ count: null, error: { message: 'boom' } })
    await expect(checkCollectionHasActiveCards(client as any, STREAMER_ID, PACK_NAME)).rejects.toBeTruthy()

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ error: { code: '08006', message: 'connection failure' } })
    primePgDb(pg)
    await expect(checkCollectionHasActiveCards(client as any, STREAMER_ID, PACK_NAME)).rejects.toBeTruthy()
  })

  it('フラグ未設定時は getDb が一切呼ばれない（挙動不変の検証）', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({ count: 1, error: null })

    await checkCollectionHasActiveCards(client as any, STREAMER_ID, PACK_NAME)
    expect(getDb).not.toHaveBeenCalled()
  })
})
