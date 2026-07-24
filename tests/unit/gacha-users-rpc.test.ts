/**
 * getGachaUsersForStreamer のPlanetScale RPCとDrizzle fallback契約。
 *
 * RPCはpostgres.jsのタグ関数、fallbackはDrizzle selectとして別々にfixture化する。
 * これによりRETURNS JSONBの変換、ページング、未デプロイ/実行時障害の集約継続を、
 * 退役したSupabase clientを再現せず検証できる。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Column, Table } from 'drizzle-orm'
import { getGachaUsersForStreamer } from '@/lib/dashboard-data'
import { getDb } from '@/lib/db/client'
import {
  cards as cardsTable,
  gachaHistory as gachaHistoryTable,
} from '@/lib/db/schema'
import { logger } from '@/lib/logger'
import { reportError } from '@/lib/sentry/error-handler'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn(),
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}))
vi.mock('next/cache', () => ({
  unstable_cache: (fn: () => Promise<unknown>) => fn,
}))

const streamerId = 'streamer-uuid-123'

function pgError(code: string, message: string) {
  return Object.assign(new Error(message), { code })
}

function createSqlResponse(result: unknown) {
  return vi.fn().mockResolvedValue(result === undefined ? [] : [{ result }])
}

function createFallbackDb(
  historyRows: Array<Record<string, unknown>> = [],
  cardRows: Array<Record<string, unknown>> = []
) {
  const rowsByTable = new Map<Table, Array<Record<string, unknown>>>([
    [gachaHistoryTable, historyRows],
    [cardsTable, cardRows],
  ])
  return {
    select: vi.fn((fields: Record<string, unknown>) => ({
      from: vi.fn((table: Table) => {
        const evaluate = () =>
          (rowsByTable.get(table) ?? []).map((row) =>
            Object.fromEntries(
              Object.entries(fields).map(([key, field]) => [
                key,
                row[(field as Column).name] ?? null,
              ])
            )
          )
        const builder: any = {
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

function primeDb(options: {
  rpcResult?: unknown
  rpcError?: unknown
  historyRows?: Array<Record<string, unknown>>
  cardRows?: Array<Record<string, unknown>>
}) {
  const sql = options.rpcError
    ? vi.fn().mockRejectedValue(options.rpcError)
    : createSqlResponse(options.rpcResult)
  const db = createFallbackDb(options.historyRows, options.cardRows)
  vi.mocked(getDb).mockResolvedValue({ db, sql } as any)
  return { sql, db }
}

const rpcUsers = {
  users: [
    {
      user_twitch_id: 'user1',
      username: 'Alice',
      draw_count: 50,
      last_draw_at: '2025-01-01T00:00:00Z',
      unique_card_ids: ['card-a', 'card-b'],
    },
    {
      user_twitch_id: 'user2',
      username: 'Bob',
      draw_count: 30,
      last_draw_at: '2025-01-02T00:00:00Z',
      unique_card_ids: ['card-a'],
    },
  ],
  total: 2,
}

const fallbackHistory = [
  {
    user_twitch_id: 'user1',
    user_twitch_username: 'Alice',
    card_id: 'card-a',
    redeemed_at: '2025-01-02T00:00:00Z',
  },
  {
    user_twitch_id: 'user1',
    user_twitch_username: 'Alice',
    card_id: 'card-b',
    redeemed_at: '2025-01-01T00:00:00Z',
  },
]

describe('getGachaUsersForStreamer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('RPC結果をGachaUserEntryへ変換する', async () => {
    primeDb({ rpcResult: rpcUsers })

    const result = await getGachaUsersForStreamer(streamerId, {
      page: 1,
      perPage: 20,
    })

    expect(result.users).toEqual([
      {
        userTwitchId: 'user1',
        username: 'Alice',
        drawCount: 50,
        uniqueCards: 2,
        uniqueCardIds: ['card-a', 'card-b'],
        lastDrawAt: '2025-01-01T00:00:00Z',
      },
      {
        userTwitchId: 'user2',
        username: 'Bob',
        drawCount: 30,
        uniqueCards: 1,
        uniqueCardIds: ['card-a'],
        lastDrawAt: '2025-01-02T00:00:00Z',
      },
    ])
    expect(result.pagination).toEqual({
      page: 1,
      perPage: 20,
      total: 2,
      totalPages: 1,
    })
  })

  it('重複したunique_card_idsを初出順で一意化する', async () => {
    primeDb({
      rpcResult: {
        users: [{
          user_twitch_id: 'user1',
          username: 'Alice',
          draw_count: 1455,
          last_draw_at: '2026-05-13T05:00:00Z',
          unique_card_ids: ['card-a', 'card-b', 'card-a', 'card-c'],
        }],
        total: 1,
      },
    })

    const result = await getGachaUsersForStreamer(streamerId)

    expect(result.users[0]).toMatchObject({
      drawCount: 1455,
      uniqueCards: 3,
      uniqueCardIds: ['card-a', 'card-b', 'card-c'],
    })
  })

  it('RPCへstreamer/limit/offsetを名前付き引数の順で渡す', async () => {
    const { sql } = primeDb({ rpcResult: { users: [], total: 0 } })

    await getGachaUsersForStreamer(streamerId, { page: 3, perPage: 10 })

    const [strings, ...values] = sql.mock.calls[0] as [readonly string[], ...unknown[]]
    expect(strings.join('$')).toContain('get_gacha_users_for_streamer')
    expect(values).toEqual([streamerId, 10, 20])
  })

  it('0件とpagination切り上げを正規化する', async () => {
    primeDb({ rpcResult: { users: [], total: 45 } })

    const result = await getGachaUsersForStreamer(streamerId, { perPage: 20 })

    expect(result.users).toEqual([])
    expect(result.pagination).toEqual({
      page: 1,
      perPage: 20,
      total: 45,
      totalPages: 3,
    })
  })

  it('username=nullを空文字へ変換する', async () => {
    primeDb({
      rpcResult: {
        users: [{
          user_twitch_id: 'user1',
          username: null,
          draw_count: 1,
          last_draw_at: '2025-01-01T00:00:00Z',
          unique_card_ids: [],
        }],
        total: 1,
      },
    })

    const result = await getGachaUsersForStreamer(streamerId)

    expect(result.users[0].username).toBe('')
  })

  it('RPC結果nullならDrizzle行からユーザー別に集約する', async () => {
    primeDb({
      rpcResult: undefined,
      historyRows: fallbackHistory,
      cardRows: [{ id: 'card-a' }, { id: 'card-b' }],
    })

    const result = await getGachaUsersForStreamer(streamerId)

    expect(result.users[0]).toMatchObject({
      userTwitchId: 'user1',
      drawCount: 2,
      uniqueCards: 2,
      uniqueCardIds: ['card-a', 'card-b'],
    })
  })

  it('RPC未デプロイ(42883)は運用通知を1回送ってDrizzle fallbackへ移る', async () => {
    primeDb({
      rpcError: pgError('42883', 'function does not exist'),
      historyRows: fallbackHistory,
      cardRows: [{ id: 'card-a' }, { id: 'card-b' }],
    })

    const result = await getGachaUsersForStreamer(streamerId)

    expect(result.users).toHaveLength(1)
    expect(logger.warn).toHaveBeenCalled()
    // 42883 はデプロイ不整合のシグナルであり、表示を継続しても運用側で検知できる
    // 必要がある。一方で fallback 自体は同一テストの行だけを使うため、通知はこの
    // RPC 欠落に対する1回に限定して検証する。
    expect(reportError).toHaveBeenCalledTimes(1)
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('get_gacha_users_for_streamer RPC unavailable (SQLSTATE 42883)'),
      }),
      {
        context: 'dashboard:get_gacha_users_for_streamer:missing',
        sqlState: '42883',
        streamerId,
      },
    )
  })

  it('42883の通知処理が失敗してもDrizzle fallbackを継続する', async () => {
    primeDb({
      rpcError: pgError('42883', 'function does not exist'),
      historyRows: fallbackHistory,
      cardRows: [{ id: 'card-a' }, { id: 'card-b' }],
    })
    vi.mocked(reportError).mockRejectedValueOnce(new Error('reporter unavailable'))

    const result = await getGachaUsersForStreamer(streamerId)

    // 可観測性基盤の障害は読み取り画面の可用性を下げない。通知側の失敗は
    // reportMissingDashboardRpc 内で隔離されるため、集約結果は通常どおり返る。
    expect(result.users[0]).toMatchObject({ userTwitchId: 'user1', drawCount: 2 })
    expect(reportError).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to persist missing dashboard RPC alert',
      expect.objectContaining({ rpcName: 'get_gacha_users_for_streamer' }),
    )
  })

  it('その他のRPCエラーはreportErrorしつつfallback結果を返す', async () => {
    primeDb({
      rpcError: pgError('42501', 'permission denied'),
      historyRows: fallbackHistory,
      cardRows: [{ id: 'card-a' }, { id: 'card-b' }],
    })

    const result = await getGachaUsersForStreamer(streamerId)

    expect(result.users[0].drawCount).toBe(2)
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('permission denied'),
      })
    )
  })
})
