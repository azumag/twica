/**
 * #803: dashboard-data の読み取りRPCをPlanetScale/postgres.js専用で検証する。
 *
 * RETURNS JSONBの外形、名前付き引数のbind順、読み取りリトライ、RPC未デプロイ時の
 * 直接SQL/Drizzle fallbackを固定する。Supabase .rpc()との二重実行比較は除去した。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Column, SQL, Table, is } from 'drizzle-orm'
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
        const evaluate = () => {
          const rows = rowsByTable.get(table) ?? []
          const hasAggregate = Object.values(fields).some((field) => is(field, SQL))
          if (hasAggregate) return [{ count: rows.length }]

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
        const builder: any = {
          leftJoin: vi.fn(() => builder),
          innerJoin: vi.fn(() => builder),
          where: vi.fn(() => builder),
          orderBy: vi.fn(() => builder),
          limit: vi.fn(() => builder),
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

  it('drop統計RPC未デプロイ時は履歴から件数・排出ユーザー・レアリティを集約する', async () => {
    const historyRows = [
      {
        card_id: 'card-a',
        user_twitch_id: 'viewer-1',
        user_twitch_username: 'viewer_one',
        redeemed_at: '2026-03-02T00:00:00+00:00',
        cards: { rarity: 'common' },
      },
      {
        card_id: 'card-a',
        user_twitch_id: 'viewer-1',
        user_twitch_username: 'Viewer New',
        redeemed_at: '2026-03-03T00:00:00+00:00',
        cards: { rarity: 'common' },
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

  it('channel point統計RPC障害時は履歴からポイントと順位を集約する', async () => {
    primeDb(
      [
        { rows: [{ result: dropStatsResult }] },
        { error: pgError('42883', 'get_channel_point_usage_stats does not exist') },
      ],
      new Map<Table, Array<Record<string, unknown>>>([
        [gachaHistoryTable, [
          {
            user_twitch_id: 'viewer-1',
            user_twitch_username: 'viewer_one',
            reward_cost: 100,
            redeemed_at: '2026-03-01T00:00:00+00:00',
          },
          {
            user_twitch_id: 'viewer-1',
            user_twitch_username: 'Viewer New',
            reward_cost: '250',
            redeemed_at: '2026-03-03T00:00:00+00:00',
          },
        ]],
      ])
    )

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
})
