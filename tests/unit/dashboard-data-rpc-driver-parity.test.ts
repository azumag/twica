/**
 * #803: dashboard-data の読み取りRPCをPlanetScale/postgres.js専用で検証する。
 *
 * RETURNS JSONBの外形、名前付き引数のbind順、読み取りリトライ、RPC未デプロイ時の
 * 直接SQL/Drizzle fallbackを固定する。Supabase .rpc()との二重実行比較は除去した。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Column, SQL, Table, is } from 'drizzle-orm'
import { drizzle as drizzleProxy } from 'drizzle-orm/pg-proxy'
import {
  getGachaCardOwnerStats,
  getGachaStats,
  getGachaUsersForStreamer,
  getUserCards,
  getUserCardsForStreamer,
} from '@/lib/dashboard-data'
import { getDb } from '@/lib/db/client'
import {
  cards as cardsTable,
  gachaHistory as gachaHistoryTable,
  userCards as userCardsTable,
} from '@/lib/db/schema'
import { logger } from '@/lib/logger'
import { reportError } from '@/lib/sentry/error-handler'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn(),
}))
vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
}))
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  return { ...actual, cache: (fn: unknown) => fn }
})

const streamer = {
  id: 'streamer-1',
  twitch_user_id: 'twitch-user-1',
  twitch_username: 'streamer_one',
  twitch_display_name: 'Streamer One',
  created_at: '2025-12-01T00:00:00+00:00',
  updated_at: '2025-12-01T00:00:00+00:00',
}

function makeRpcCard(overrides: Record<string, unknown> = {}) {
  return {
    id: 'card-a',
    streamer_id: 'streamer-1',
    name: 'Card A',
    description: null,
    image_url: 'https://example.com/card-a.png',
    rarity: 'common',
    rarity_order: 4,
    drop_rate: '0.25',
    is_active: true,
    created_at: '2026-01-01T00:00:00+00:00',
    updated_at: '2026-01-01T00:00:00+00:00',
    ...overrides,
  }
}

const userCardRows = [
  { count: 2, card: makeRpcCard(), streamer },
  {
    count: 1,
    card: makeRpcCard({
      id: 'card-b',
      name: 'Card B',
      rarity: 'rare',
      rarity_order: 3,
    }),
    streamer,
  },
]

const gachaUsersResult = {
  users: [{
    user_twitch_id: 'viewer-1',
    username: 'viewer_one',
    draw_count: 5,
    last_draw_at: '2026-03-02 00:00:00+00',
    unique_card_ids: ['card-a', 'card-b'],
  }],
  total: 12,
}

const dropStatsResult = {
  total_draws: '10',
  card_stats: [{
    card_id: 'card-a',
    card_name: 'Card A',
    rarity: 'common',
    image_url: 'https://example.com/card-a.png',
    configured_rate: '25.5',
    actual_count: '4',
    actual_rate: '40',
    drawer_count: '2',
    drawers: [{
      user_twitch_id: 'viewer-1',
      username: 'viewer_one',
      draw_count: '3',
      last_drawn_at: '2026-03-02 00:00:00+00',
    }],
  }],
  rarity_stats: [{ rarity: 'common', count: '4', rate: '40' }],
}

const channelPointResult = {
  total_points: '500',
  ranking: [{
    user_twitch_id: 'viewer-1',
    username: 'viewer_one',
    total_points: '300',
    redemption_count: 3,
    last_redeemed_at: '2026-03-02 00:00:00+00',
  }],
}

const ownerStatsResult = {
  card_stats: [{
    card_id: 'card-a',
    card_name: 'Card A',
    rarity: 'common',
    image_url: 'https://example.com/card-a.png',
    owner_count: '2',
    owners: [{
      user_twitch_id: 'viewer-1',
      username: 'viewer_one',
      display_name: 'Viewer One',
      owned_count: '2',
      last_obtained_at: '2026-03-02 00:00:00+00',
    }],
  }],
}

const fallbackHistoryRows = [
  {
    user_twitch_id: 'viewer-1',
    user_twitch_username: 'viewer_one',
    card_id: 'card-a',
    redeemed_at: '2026-03-02T00:00:00+00:00',
  },
  {
    user_twitch_id: 'viewer-2',
    user_twitch_username: 'viewer_two',
    card_id: 'card-b',
    redeemed_at: '2026-03-01T12:00:00+00:00',
  },
  {
    user_twitch_id: 'viewer-1',
    user_twitch_username: 'viewer_one',
    card_id: 'card-inactive',
    redeemed_at: '2026-03-01T00:00:00+00:00',
  },
]

function pgError(code: string, message: string) {
  return Object.assign(new Error(message), { code })
}

function createSqlMock(responses: Array<{ rows?: unknown[]; error?: unknown }>) {
  let index = 0
  return vi.fn(() => {
    const response = responses[Math.min(index, responses.length - 1)]
    index += 1
    return response.error
      ? Promise.reject(response.error)
      : Promise.resolve(response.rows ?? [])
  })
}

function renderSqlCall(sql: ReturnType<typeof vi.fn>, index: number) {
  const [strings, ...values] = sql.mock.calls[index] as [readonly string[], ...unknown[]]
  return { text: strings.join('$'), values }
}

function createFallbackDb(
  rowsByTable: Map<Table, Array<Record<string, unknown>>> = new Map()
) {
  return {
    select: vi.fn((fields: Record<string, unknown>) => ({
      from: vi.fn((table: Table) => {
        let groupByColumns: Column[] = []
        const evaluate = () => {
          const rows = rowsByTable.get(table) ?? []
          const aggregateEntries = Object.entries(fields).filter(([, field]) => is(field, SQL))
          const columnEntries = Object.entries(fields).filter(([, field]) => is(field, Column))

          if (aggregateEntries.length === 0) {
            return rows.map((row) =>
              Object.fromEntries(
                Object.entries(fields).map(([key, field]) => {
                  if (is(field, Column)) return [key, row[field.name] ?? null]
                  // JOIN後のネスト値はfixture側でキー名どおりに保持する。
                  // SQL条件の再実装を避けつつ、公開結果のネスト形状は厳密に検証できる。
                  return [key, row[key] ?? null]
                })
              )
            )
          }

          // groupBy() 呼び出しが無い集計 = 全体件数のみ(既存の挙動)。
          if (groupByColumns.length === 0) {
            return [{ count: rows.length }]
          }

          // groupBy() 呼び出しあり = GROUP BY をシミュレートする。groupBy対象の
          // カラム値でグループ化し、各グループの行をまとめて保持する
          // (#833のGROUP BY集計テスト用)。
          const groups = new Map<string, { keyValues: Record<string, unknown>; rowsInGroup: Record<string, unknown>[] }>()
          for (const row of rows) {
            const keyValues: Record<string, unknown> = {}
            for (const [key, field] of columnEntries) {
              if (is(field, Column)) keyValues[key] = row[field.name] ?? null
            }
            const groupKey = groupByColumns.map((col) => String(row[col.name] ?? '')).join('|')
            const existing = groups.get(groupKey)
            if (existing) {
              existing.rowsInGroup.push(row)
            } else {
              groups.set(groupKey, { keyValues, rowsInGroup: [row] })
            }
          }
          return Array.from(groups.values()).map(({ keyValues, rowsInGroup }) => {
            const result: Record<string, unknown> = { ...keyValues }
            for (const [key, field] of aggregateEntries) {
              // count()はsql`count(${sql.raw("*")})`、countDistinct(col)は
              // sql`count(distinct ${col})`として表現される(drizzle-orm/sql/
              // functions/aggregate.js)。queryChunks内にColumnが含まれるかで
              // 両者を判別し、distinct集計ならグループ内のユニーク値数を返す。
              const distinctColumn = (field as SQL).queryChunks.find((chunk) => is(chunk, Column)) as
                | Column
                | undefined
              result[key] = distinctColumn
                ? new Set(rowsInGroup.map((r) => r[distinctColumn.name])).size
                : rowsInGroup.length
            }
            return result
          })
        }
        const builder: any = {
          leftJoin: vi.fn(() => builder),
          innerJoin: vi.fn(() => builder),
          where: vi.fn(() => builder),
          orderBy: vi.fn(() => builder),
          limit: vi.fn(() => builder),
          groupBy: vi.fn((...columns: Column[]) => {
            groupByColumns = columns
            return builder
          }),
          then: (onFulfilled: any, onRejected: any) =>
            Promise.resolve().then(evaluate).then(onFulfilled, onRejected),
        }
        return builder
      }),
    })),
  }
}

function primeDb(
  responses: Array<{ rows?: unknown[]; error?: unknown }>,
  rowsByTable?: Map<Table, Array<Record<string, unknown>>>
) {
  const sql = createSqlMock(responses)
  const db = createFallbackDb(rowsByTable)
  vi.mocked(getDb).mockResolvedValue({ db, sql } as any)
  return { sql, db }
}

/**
 * 実DBへ接続せず、DrizzleのPostgreSQL dialectが生成したSQL/paramsを捕捉する。
 * 手製builderは完成済み行しか検証できないため、Issue #849の集計SQL契約に限って
 * pg-proxyを使い、実際のquery builder生成結果と行デコードの両方を固定する。
 */
function createCapturingPgProxyDb(rows: unknown[][]) {
  const queries: Array<{
    sql: string
    params: unknown[]
    method: 'all' | 'execute'
  }> = []
  const db = drizzleProxy(async (query, params, method) => {
    queries.push({ sql: query, params: [...params], method })
    return { rows }
  })
  return { db, queries }
}

describe('dashboard-data: PlanetScale読み取りRPC契約 (#803)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(reportError).mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('getUserCardsはJSONB行配列を正規化し、text引数だけをbindする', async () => {
    const { sql } = primeDb([{ rows: [{ result: userCardRows }] }])

    const result = await getUserCards('viewer-1')

    expect(result).toEqual([
      { ...makeRpcCard(), drop_rate: 0.25, streamer, count: 2 },
      {
        ...makeRpcCard({
          id: 'card-b',
          name: 'Card B',
          rarity: 'rare',
          rarity_order: 3,
        }),
        drop_rate: 0.25,
        streamer,
        count: 1,
      },
    ])
    const call = renderSqlCall(sql, 0)
    expect(call.text).toContain('get_user_card_counts')
    expect(call.text).not.toContain('p_streamer_id')
    expect(call.values).toEqual(['viewer-1'])
  })

  it('RPC未デプロイ(42883)は監視報告を試み、reporter障害でも直接SQLへfallbackする', async () => {
    vi.mocked(reportError).mockRejectedValueOnce(new Error('error reporter unavailable'))
    const { sql } = primeDb([
      { error: pgError('42883', 'function does not exist') },
      { rows: userCardRows },
    ])

    const result = await getUserCards('viewer-1')

    expect(sql).toHaveBeenCalledTimes(2)
    expect(result).toHaveLength(2)
    expect(logger.warn).toHaveBeenCalledWith(
      'get_user_card_counts not deployed, falling back to direct PlanetScale query',
      { twitchUserId: 'viewer-1' },
    )
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('get_user_card_counts RPC unavailable (SQLSTATE 42883)'),
      }),
      expect.objectContaining({
        context: 'dashboard:get_user_card_counts:missing',
        sqlState: '42883',
        twitchUserId: 'viewer-1',
      }),
    )
    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to persist missing dashboard RPC alert',
      {
        rpcName: 'get_user_card_counts',
        error: 'error reporter unavailable',
      },
    )
  })

  it('RPC実行時エラーは可観測化しつつ直接SQL結果を返す', async () => {
    primeDb([
      { error: pgError('42501', 'permission denied') },
      { rows: userCardRows },
    ])

    await expect(getUserCards('viewer-1')).resolves.toHaveLength(2)
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('permission denied'),
      })
    )
  })

  it('接続断は読み取りRPCを再試行して成功する', async () => {
    vi.useFakeTimers()
    const { sql } = primeDb([
      { error: pgError('CONNECTION_CLOSED', 'connection closed') },
      { rows: [{ result: userCardRows }] },
    ])

    const resultPromise = getUserCards('viewer-1')
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toHaveLength(2)
    expect(sql).toHaveBeenCalledTimes(2)
    expect(getDb).toHaveBeenCalledTimes(2)
  })

  it('streamer指定カードRPCはuuid引数を追加する', async () => {
    const { sql } = primeDb([{ rows: [{ result: userCardRows }] }])

    await getUserCardsForStreamer('viewer-1', 'streamer-1')

    const call = renderSqlCall(sql, 0)
    expect(call.text).toContain('p_streamer_id => $::uuid')
    expect(call.values).toEqual(['viewer-1', 'streamer-1'])
  })

  it('gacha user RPCはuuid/integer引数とpaginationを正規化する', async () => {
    const { sql } = primeDb([{ rows: [{ result: gachaUsersResult }] }])

    const result = await getGachaUsersForStreamer('streamer-1', {
      page: 2,
      perPage: 20,
    })

    expect(result).toEqual({
      users: [{
        userTwitchId: 'viewer-1',
        username: 'viewer_one',
        drawCount: 5,
        uniqueCards: 2,
        uniqueCardIds: ['card-a', 'card-b'],
        lastDrawAt: '2026-03-02 00:00:00+00',
      }],
      pagination: { page: 2, perPage: 20, total: 12, totalPages: 1 },
    })
    const call = renderSqlCall(sql, 0)
    expect(call.text).toContain('p_streamer_id => $::uuid')
    expect(call.text).toContain('p_limit => $::integer')
    expect(call.text).toContain('p_offset => $::integer')
    expect(call.values).toEqual(['streamer-1', 20, 20])
  })

  it('gacha user RPC障害時はDrizzle fallbackでactive cardだけを集約する', async () => {
    primeDb(
      [{ error: pgError('57014', 'statement timeout') }],
      new Map<Table, Array<Record<string, unknown>>>([
        [gachaHistoryTable, fallbackHistoryRows],
        [cardsTable, [{ id: 'card-a' }, { id: 'card-b' }]],
      ])
    )

    const result = await getGachaUsersForStreamer('streamer-1')

    expect(result.users).toEqual([
      {
        userTwitchId: 'viewer-1',
        username: 'viewer_one',
        drawCount: 2,
        uniqueCards: 1,
        uniqueCardIds: ['card-a'],
        lastDrawAt: '2026-03-02T00:00:00+00:00',
      },
      {
        userTwitchId: 'viewer-2',
        username: 'viewer_two',
        drawCount: 1,
        uniqueCards: 1,
        uniqueCardIds: ['card-b'],
        lastDrawAt: '2026-03-01T12:00:00+00:00',
      },
    ])
    expect(reportError).toHaveBeenCalled()
  })

  it('2種の統計RPCを並列実行し、数値文字列をnumberへ変換する', async () => {
    const { sql } = primeDb([
      { rows: [{ result: dropStatsResult }] },
      { rows: [{ result: channelPointResult }] },
    ])

    const result = await getGachaStats('streamer-1', '7d')

    expect(result.totalDraws).toBe(10)
    expect(result.cardStats[0]).toMatchObject({
      cardId: 'card-a',
      configuredRate: 25.5,
      actualCount: 4,
      drawerCount: 2,
    })
    expect(result.channelPointStats.totalPoints).toBe(500)
    expect(sql).toHaveBeenCalledTimes(2)
    const dropCall = renderSqlCall(sql, 0)
    expect(dropCall.text).toContain('get_gacha_drop_stats')
    expect(dropCall.values[0]).toBe('streamer-1')
    expect(typeof dropCall.values[1]).toBe('string')
    const pointCall = renderSqlCall(sql, 1)
    expect(pointCall.text).toContain('get_channel_point_usage_stats')
    expect(pointCall.values).toEqual(['streamer-1', null, 10])
  })

  it('#833: RPC経路はカスタムレアリティをそのまま(固定4種にハードコードせず)返す', async () => {
    // #833の本質的な原因はJSフォールバック側が固定4レアリティにハードコード
    // していたことで、RPC側(parseGachaDropStatsRpc)は元々rarity_statsの
    // 内容をそのまま透過するだけで正しい。両経路が同じ入力に同じ結果を
    // 返すことを固定し、将来どちらかにハードコードが再導入されたら
    // このテストで検知できるようにする。
    const dropStatsWithCustomRarity = {
      ...dropStatsResult,
      rarity_stats: [
        { rarity: 'legendary', count: '0', rate: '0' },
        { rarity: 'epic', count: '0', rate: '0' },
        { rarity: 'rare', count: '0', rate: '0' },
        { rarity: 'common', count: '6', rate: '60' },
        { rarity: 'mythic', count: '4', rate: '40' },
      ],
    }
    primeDb([
      { rows: [{ result: dropStatsWithCustomRarity }] },
      { rows: [{ result: channelPointResult }] },
    ])

    const result = await getGachaStats('streamer-1', '7d')

    const mythicStat = result.rarityStats.find((row) => row.rarity === 'mythic')
    expect(mythicStat).toMatchObject({ count: 4, rate: 40 })
    expect(result.rarityStats).toHaveLength(5)
    const sumOfCounts = result.rarityStats.reduce((sum, row) => sum + row.count, 0)
    expect(sumOfCounts).toBe(10)
    expect(sumOfCounts).toBe(result.totalDraws)
  })

  it('drop統計RPC未デプロイ時は履歴から件数・排出ユーザー・レアリティを集約する', async () => {
    // rarity は #833 以降 cardsTable.rarity への INNER JOIN + GROUP BY で
    // 取得するため、fixture側もフラットな rarity フィールドを持たせる
    // (createFallbackDb の GROUP BY シミュレーションが row[column.name] で
    // 引くため、ネストした cards.rarity では解決できない)。
    const historyRows = [
      {
        card_id: 'card-a',
        user_twitch_id: 'viewer-1',
        user_twitch_username: 'viewer_one',
        redeemed_at: '2026-03-02T00:00:00+00:00',
        rarity: 'common',
      },
      {
        card_id: 'card-a',
        user_twitch_id: 'viewer-1',
        user_twitch_username: 'Viewer New',
        redeemed_at: '2026-03-03T00:00:00+00:00',
        rarity: 'common',
      },
    ]
    primeDb(
      [
        { error: pgError('42883', 'get_gacha_drop_stats does not exist') },
        { rows: [{ result: channelPointResult }] },
      ],
      new Map<Table, Array<Record<string, unknown>>>([
        [gachaHistoryTable, historyRows],
        [cardsTable, [{
          id: 'card-a',
          name: 'Card A',
          rarity: 'common',
          image_url: null,
          drop_rate: 1,
          created_at: '2026-01-01T00:00:00+00:00',
        }]],
      ])
    )

    const result = await getGachaStats('streamer-1', '7d')

    expect(result.totalDraws).toBe(2)
    expect(result.cardStats[0]).toMatchObject({
      cardId: 'card-a',
      actualCount: 2,
      actualRate: 100,
      drawerCount: 1,
      drawers: [{
        userTwitchId: 'viewer-1',
        username: 'Viewer New',
        drawCount: 2,
        lastDrawnAt: '2026-03-03T00:00:00+00:00',
      }],
    })
    expect(result.rarityStats.find((row) => row.rarity === 'common')).toMatchObject({
      count: 2,
      rate: 100,
    })
    expect(logger.warn).toHaveBeenCalledWith(
      'get_gacha_drop_stats not deployed, falling back to direct PlanetScale query',
      { streamerId: 'streamer-1' },
    )
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('get_gacha_drop_stats RPC unavailable (SQLSTATE 42883)'),
      }),
      expect.objectContaining({
        context: 'dashboard:get_gacha_drop_stats:missing',
        sqlState: '42883',
        streamerId: 'streamer-1',
      }),
    )
  })

  it('#833: カスタムレアリティを含み、履歴サンプル上限を超える件数でも件数・レアリティ内訳が正確', async () => {
    // 実運用では10000件超の履歴サンプルで actualCount/rarityStats が黙って
    // 過小になっていた(#833)。ここではGROUP BY集計(count=25000)が
    // 履歴サンプル(空配列=0件)から独立していることを直接検証する:
    // もし実装がhistory配列から数え直す旧ロジックに戻れば、actualCount/
    // rarityStatsのcountは0になりこのテストは失敗する。
    const sql = createSqlMock([
      { error: pgError('42883', 'get_gacha_drop_stats does not exist') },
      { rows: [{ result: channelPointResult }] },
    ])
    let selectCallIndex = 0
    const groupByResponses = [
      [{ count: 25000 }], // count-only
      [], // history detail sample(空でも件数計算に影響しないことを示す)
      [{
        id: 'card-a',
        name: 'Card A',
        rarity: 'mythic', // デフォルト4種に無いカスタムレアリティ
        image_url: null,
        drop_rate: 1,
        created_at: '2026-01-01T00:00:00+00:00',
      }],
      [{ card_id: 'card-a', count: 25000 }], // drawCountsByCard(GROUP BY)
      [{ rarity: 'mythic', count: 25000 }], // rarityCounts(GROUP BY)
      [{ card_id: 'card-a', count: 500 }], // drawerCountsByCard(GROUP BY COUNT DISTINCT)
    ]
    const db = {
      select: vi.fn(() => {
        const response = groupByResponses[Math.min(selectCallIndex, groupByResponses.length - 1)]
        selectCallIndex += 1
        const builder: any = {
          from: vi.fn(() => builder),
          innerJoin: vi.fn(() => builder),
          leftJoin: vi.fn(() => builder),
          where: vi.fn(() => builder),
          orderBy: vi.fn(() => builder),
          limit: vi.fn(() => builder),
          groupBy: vi.fn(() => builder),
          then: (onFulfilled: any, onRejected: any) =>
            Promise.resolve(response).then(onFulfilled, onRejected),
        }
        return builder
      }),
    }
    vi.mocked(getDb).mockResolvedValue({ db, sql } as any)

    const result = await getGachaStats('streamer-1', '7d')

    expect(result.totalDraws).toBe(25000)
    expect(result.cardStats[0]).toMatchObject({
      cardId: 'card-a',
      actualCount: 25000,
      actualRate: 100,
      // drawerCountはGROUP BY集計(500)から取り、空の履歴サンプルから0と
      // 誤って数え直されない(レビュー指摘: actualCountだけ大きくdrawerCountが
      // 0のままだと矛盾した表示になる)
      drawerCount: 500,
      drawers: [], // 明細一覧は履歴サンプル(空)のまま=付随情報として空でよい
    })
    const mythicStat = result.rarityStats.find((row) => row.rarity === 'mythic')
    expect(mythicStat).toMatchObject({ count: 25000, rate: 100 })
    // デフォルト4種(排出0でも表示)+実際に排出されたカスタムレアリティの順で並ぶ
    expect(result.rarityStats.map((row) => row.rarity)).toEqual([
      'legendary', 'epic', 'rare', 'common', 'mythic',
    ])
    // rarityStatsの内訳合計がtotal_drawsと一致する(カスタムレアリティ込み)
    const sumOfCounts = result.rarityStats.reduce((sum, row) => sum + row.count, 0)
    expect(sumOfCounts).toBe(25000)
  })

  it('channel point統計RPC障害時は履歴からポイントと順位を集約する', async () => {
    const sql = createSqlMock([
      { rows: [{ result: dropStatsResult }] },
      { error: pgError('42883', 'get_channel_point_usage_stats does not exist') },
    ])
    const { db } = createCapturingPgProxyDb([[
      'viewer-1',
      'Viewer New',
      '350',
      2,
      '2026-03-03T00:00:00+00:00',
      '350',
    ]])
    vi.mocked(getDb).mockResolvedValue({ db, sql } as any)

    const result = await getGachaStats('streamer-1', '30d')

    expect(result.channelPointStats).toEqual({
      totalPoints: 350,
      ranking: [{
        userTwitchId: 'viewer-1',
        username: 'Viewer New',
        totalPoints: 350,
        redemptionCount: 2,
        lastRedeemedAt: '2026-03-03T00:00:00+00:00',
      }],
    })
    expect(logger.warn).toHaveBeenCalledWith(
      'get_channel_point_usage_stats not deployed, falling back to direct PlanetScale query',
      { streamerId: 'streamer-1' },
    )
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('get_channel_point_usage_stats RPC unavailable (SQLSTATE 42883)'),
      }),
      expect.objectContaining({
        context: 'dashboard:get_channel_point_usage_stats:missing',
        sqlState: '42883',
        streamerId: 'streamer-1',
      }),
    )
  })

  it('channel point fallbackは10000件超でもDB集計値の上位Nとusername fallbackを返す', async () => {
    // 10,000件の明細取得上限とは独立して、DBが返したwindow総計とユーザー別SUMを
    // 採用する。pg-proxy経由で実際の生成SQLも検証し、完成済みmock値だけを返して
    // 誤ったクエリを見逃さないようにする。
    const sql = createSqlMock([
      { rows: [{ result: dropStatsResult }] },
      { error: pgError('42883', 'get_channel_point_usage_stats does not exist') },
    ])
    const { db, queries } = createCapturingPgProxyDb([
      [
        'viewer-top', 'Top Viewer', '1500000', '15000',
        '2026-03-03T00:00:00+00:00', '2500000',
      ],
      [
        'viewer-fallback', null, '1000000', '12000',
        '2026-03-02T00:00:00+00:00', '2500000',
      ],
    ])
    vi.mocked(getDb).mockResolvedValue({ db, sql } as any)

    const result = await getGachaStats('streamer-1', '30d')

    expect(result.channelPointStats).toEqual({
      totalPoints: 2500000,
      ranking: [
        {
          userTwitchId: 'viewer-top', username: 'Top Viewer', totalPoints: 1500000,
          redemptionCount: 15000, lastRedeemedAt: '2026-03-03T00:00:00+00:00',
        },
        {
          userTwitchId: 'viewer-fallback', username: 'viewer-fallback', totalPoints: 1000000,
          redemptionCount: 12000, lastRedeemedAt: '2026-03-02T00:00:00+00:00',
        },
      ],
    })
    expect(queries).toHaveLength(1)
    const generated = queries[0]
    expect(generated.method).toBe('all')
    expect(generated.params).toEqual(['streamer-1', 0, 10])
    expect(generated.sql).toMatch(/from "gacha_history"/i)
    expect(generated.sql).toMatch(/"gacha_history"\."streamer_id" = \$1/i)
    expect(generated.sql).toMatch(/"gacha_history"\."reward_cost" > \$2/i)
    // PostgreSQL dialectはSELECT式の同一テーブル列を非修飾で出力する一方、
    // WHERE/GROUP BY/ORDER BYでは修飾する。実際の生成SQLをそのまま固定する。
    expect(generated.sql).toMatch(/coalesce\(max\("user_twitch_username"\), "user_twitch_id"\)/i)
    expect(generated.sql).toMatch(/sum\("reward_cost"\)/i)
    expect(generated.sql).toMatch(/count\(\*\)/i)
    expect(generated.sql).toMatch(/max\("redeemed_at"\)/i)
    expect(generated.sql).toMatch(/sum\(sum\("reward_cost"\)\) over \(\)/i)
    expect(generated.sql).toMatch(/group by "gacha_history"\."user_twitch_id"/i)
    expect(generated.sql).toMatch(/order by sum\("gacha_history"\."reward_cost"\) desc, count\(\*\) desc, max\("gacha_history"\."redeemed_at"\) desc/i)
    expect(generated.sql).toMatch(/limit \$3/i)
  })

  it('channel point fallbackは対象履歴が空なら0ポイント・空ランキングを返す', async () => {
    const sql = createSqlMock([
      { rows: [{ result: dropStatsResult }] },
      { error: pgError('42883', 'get_channel_point_usage_stats does not exist') },
    ])
    const { db, queries } = createCapturingPgProxyDb([])
    vi.mocked(getDb).mockResolvedValue({ db, sql } as any)

    const result = await getGachaStats('streamer-1', '30d')

    expect(result.channelPointStats).toEqual({ totalPoints: 0, ranking: [] })
    expect(queries).toHaveLength(1)
  })

  it('card owner RPCをuuid引数で実行し、owner値を正規化する', async () => {
    const { sql } = primeDb([{ rows: [{ result: ownerStatsResult }] }])

    const result = await getGachaCardOwnerStats('streamer-1')

    expect(result).toEqual({
      cardStats: [{
        cardId: 'card-a',
        cardName: 'Card A',
        rarity: 'common',
        imageUrl: 'https://example.com/card-a.png',
        ownerCount: 2,
        owners: [{
          userTwitchId: 'viewer-1',
          username: 'viewer_one',
          displayName: 'Viewer One',
          ownedCount: 2,
          lastObtainedAt: '2026-03-02 00:00:00+00',
        }],
      }],
    })
    const call = renderSqlCall(sql, 0)
    expect(call.text).toContain('get_card_owner_stats')
    expect(call.values).toEqual(['streamer-1'])
  })

  it('card owner RPC未デプロイ時はDrizzleの所持行をユーザー別に集約する', async () => {
    primeDb(
      [{ error: pgError('42883', 'get_card_owner_stats does not exist') }],
      new Map<Table, Array<Record<string, unknown>>>([
        [cardsTable, [{
          id: 'card-a',
          name: 'Card A',
          rarity: 'common',
          image_url: null,
        }]],
        [userCardsTable, [
          {
            card_id: 'card-a',
            obtained_at: '2026-03-01T00:00:00+00:00',
            users: {
              twitch_user_id: 'viewer-1',
              twitch_username: 'viewer_one',
              twitch_display_name: 'Viewer One',
            },
          },
          {
            card_id: 'card-a',
            obtained_at: '2026-03-03T00:00:00+00:00',
            users: {
              twitch_user_id: 'viewer-1',
              twitch_username: 'viewer_one',
              twitch_display_name: 'Viewer One',
            },
          },
        ]],
      ])
    )

    const result = await getGachaCardOwnerStats('streamer-1')

    expect(result).toEqual({
      cardStats: [{
        cardId: 'card-a',
        cardName: 'Card A',
        rarity: 'common',
        imageUrl: null,
        ownerCount: 1,
        owners: [{
          userTwitchId: 'viewer-1',
          username: 'viewer_one',
          displayName: 'Viewer One',
          ownedCount: 2,
          lastObtainedAt: '2026-03-03T00:00:00+00:00',
        }],
      }],
    })
    expect(logger.warn).toHaveBeenCalledWith(
      'get_card_owner_stats not deployed, falling back to direct PlanetScale query',
      { streamerId: 'streamer-1' },
    )
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('get_card_owner_stats RPC unavailable (SQLSTATE 42883)'),
      }),
      expect.objectContaining({
        context: 'dashboard:get_card_owner_stats:missing',
        sqlState: '42883',
        streamerId: 'streamer-1',
      }),
    )
  })

  it('#833: 所持ユーザー明細サンプル件数を超えても、ownerCountはGROUP BY集計から正確な値を返す', async () => {
    // 実運用ではownerRowsのLIMIT 10000サンプルからownerCountを数えていたため、
    // streamer全体のuser_cards行数が10000件を超えると人気カードのownerCountが
    // 黙って過小になっていた(#833)。ここではownerRows(明細サンプル)を空にし、
    // 別のGROUP BY集計(COUNT DISTINCT)だけがownerCountを決めることを直接示す。
    let selectCallIndex = 0
    const responses = [
      [{ id: 'card-a', name: 'Card A', rarity: 'common', image_url: null }], // cards
      [], // ownerRows(明細サンプル、空でもownerCountに影響しないことを示す)
      [{ card_id: 'card-a', count: 3000 }], // ownerCounts(GROUP BY COUNT DISTINCT)
    ]
    const db = {
      select: vi.fn(() => {
        const response = responses[Math.min(selectCallIndex, responses.length - 1)]
        selectCallIndex += 1
        const builder: any = {
          from: vi.fn(() => builder),
          innerJoin: vi.fn(() => builder),
          where: vi.fn(() => builder),
          orderBy: vi.fn(() => builder),
          limit: vi.fn(() => builder),
          groupBy: vi.fn(() => builder),
          then: (onFulfilled: any, onRejected: any) =>
            Promise.resolve(response).then(onFulfilled, onRejected),
        }
        return builder
      }),
    }
    const sql = createSqlMock([{ error: pgError('42883', 'get_card_owner_stats does not exist') }])
    vi.mocked(getDb).mockResolvedValue({ db, sql } as any)

    const result = await getGachaCardOwnerStats('streamer-1')

    expect(result.cardStats[0]).toMatchObject({
      cardId: 'card-a',
      ownerCount: 3000,
      owners: [],
    })
  })
})
