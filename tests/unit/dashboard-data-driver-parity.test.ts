/**
 * dashboard-data の非 RPC 読み取りを、移行後の唯一の実行経路である
 * Drizzle/PlanetScale(PostgreSQL) 境界で検証する。
 *
 * 旧 PostgREST との「ドライバーパリティ」は移行完了後の実装契約ではないため、
 * テストでは Drizzle の選択列・JOIN 後の形状・空結果・段階的デプロイ用の
 * 42703 フォールバックを直接検証する。DB モックは実 schema の Table/Column を
 * キーに射影するため、文字列ベースの fixture より列選択漏れを検出しやすい。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Column, SQL, Table, getTableColumns, is } from 'drizzle-orm'
import {
  getActiveCardCountsForStreamers,
  getActiveCardsForStreamer,
  getCollectionCompletions,
  getGachaHistoryForStreamer,
  getGachaHistoryForUser,
  getRecentGachaHistory,
  getStreamerById,
  getStreamerData,
  getStreamerDataPaginated,
  getUserCardDetail,
} from '@/lib/dashboard-data'
import { getDb } from '@/lib/db/client'
import {
  cards as cardsTable,
  collectionCompletions as collectionCompletionsTable,
  gachaHistory as gachaHistoryTable,
  streamers as streamersTable,
  userCards as userCardsTable,
  users as usersTable,
} from '@/lib/db/schema'
import { CARDS_SAFE_COLUMNS } from '@/lib/db/cards-safe-columns'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn(),
  // DBエラー時にlogger.serverが要求する永続化exportも明示し、ログ副作用を隔離する。
  logErrorFromLogger: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
}))
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  return { ...actual, cache: (fn: unknown) => fn }
})

function makeStreamerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'streamer-1',
    twitch_user_id: 'twitch-user-1',
    twitch_username: 'streamer_one',
    twitch_display_name: 'Streamer One',
    twitch_profile_image_url: null,
    channel_point_reward_id: null,
    channel_point_reward_name: null,
    channel_point_collection_name: null,
    is_active: true,
    gacha_sound_url: null,
    gacha_sound_enabled: false,
    gacha_sound_rules: [],
    chat_announcement_enabled: false,
    chat_announcement_template: null,
    chat_announcement_multi_template: null,
    chat_announcement_multi_show_cards: true,
    rarity_weights: null,
    rarity_weights_scope: 'global',
    pack_rarity_weights: null,
    custom_rarities: [],
    card_pack_names: [],
    default_card_pack_name: null,
    show_unowned_cards: false,
    show_unowned_card_details: false,
    raid_gacha_active_until: null,
    raid_gacha_draw_count: 0,
    created_at: '2025-12-01T00:00:00.000+00:00',
    updated_at: '2025-12-01T00:00:00.000+00:00',
    ...overrides,
  }
}

function makeCardRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'card-1',
    streamer_id: 'streamer-1',
    name: 'Card One',
    description: null,
    image_url: 'https://example.com/card1.png',
    rarity: 'common',
    rarity_order: 4,
    drop_rate: 0.25,
    intra_rarity_weight: 1,
    card_number: null,
    max_issuance_count: null,
    collection_name: null,
    is_active: true,
    hp: 100,
    atk: 30,
    def: 15,
    spd: 5,
    skill_type: 'attack',
    skill_name: '通常攻撃',
    skill_power: 10,
    created_at: '2026-01-01T00:00:00.000+00:00',
    updated_at: '2026-01-01T00:00:00.000+00:00',
    ...overrides,
  }
}

function makeHistoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'history-1',
    event_id: null,
    user_twitch_id: 'viewer-1',
    user_twitch_username: 'viewer_one',
    card_id: 'card-old',
    streamer_id: 'streamer-1',
    reward_cost: 100,
    reward_id: null,
    redeemed_at: '2026-02-01T00:00:00.000+00:00',
    ...overrides,
  }
}

const STREAMER = makeStreamerRow()
const CARD_OLD = makeCardRow({ id: 'card-old' })
const CARD_NEW = makeCardRow({
  id: 'card-new',
  rarity: 'rare',
  rarity_order: 3,
  created_at: '2026-01-03T00:00:00.000+00:00',
})
const HISTORY_OLD = makeHistoryRow()
const HISTORY_NEW = makeHistoryRow({
  id: 'history-2',
  card_id: 'card-new',
  redeemed_at: '2026-02-02T00:00:00.000+00:00',
})

function missingColumnError(column = 'hp') {
  return Object.assign(new Error(`column "${column}" does not exist`), {
    code: '42703',
  })
}

interface DrizzleMockConfig {
  tables?: Map<Table, Array<Record<string, unknown>>>
  counts?: Map<Table, number>
  errors?: Map<Table, unknown[]>
}

/**
 * 異なる schema table を同じ Map に入れる際、TypeScript が先頭tableだけへ
 * キー型を狭めないよう、DrizzleMockConfig と同じ共通キー型を入口で固定する。
 */
function tableRows(
  entries: Array<[Table, Array<Record<string, unknown>>]>
): Map<Table, Array<Record<string, unknown>>> {
  return new Map<Table, Array<Record<string, unknown>>>(entries)
}

/**
 * Drizzle が行う「選択フィールドの射影」と LEFT JOIN の null 拡張だけを
 * 再現する。WHERE/ORDER/LIMIT の SQL 評価はテスト対象外であり、fixture 自体を
 * DB が返した最終行とみなす。集計 SELECT は常に1行を返し、行 SELECT と
 * Promise.all で並行実行されても列欠落エラーのキューを奪わないようにする。
 */
function createDrizzleDbMock(config: DrizzleMockConfig = {}) {
  const db = {
    select: vi.fn((fields?: Record<string, unknown>) => ({
      from: vi.fn((mainTable: Table) => {
        const joins: Array<{ table: Table; on: SQL }> = []

        const evaluate = () => {
          const selection = fields ?? (getTableColumns(mainTable) as Record<string, unknown>)
          const hasAggregate = Object.values(selection).some((field) => is(field, SQL))

          if (!hasAggregate) {
            const errors = config.errors?.get(mainTable)
            if (errors?.length) throw errors.shift()
          }

          type Context = Map<Table, Record<string, unknown> | null>
          let contexts: Context[] = (config.tables?.get(mainTable) ?? []).map(
            (row) => new Map([[mainTable, row]]) as Context
          )

          for (const join of joins) {
            const joinRows = config.tables?.get(join.table) ?? []
            const columns = join.on.queryChunks.filter((chunk): chunk is Column =>
              is(chunk, Column)
            )
            const joinColumn = columns.find((column) => column.table === (join.table as unknown))
            const sourceColumn = columns.find((column) => column.table !== (join.table as unknown))
            if (!joinColumn || !sourceColumn) {
              throw new Error('unsupported join condition in Drizzle test double')
            }

            const next: Context[] = []
            for (const context of contexts) {
              const sourceRow = context.get(sourceColumn.table as unknown as Table)
              const sourceValue = sourceRow?.[sourceColumn.name]
              const matches =
                sourceValue == null
                  ? []
                  : joinRows.filter((row) => row[joinColumn.name] === sourceValue)

              if (matches.length === 0) {
                next.push(new Map(context).set(join.table, null))
              } else {
                for (const match of matches) {
                  next.push(new Map(context).set(join.table, match))
                }
              }
            }
            contexts = next
          }

          const project = (
            selected: Record<string, unknown>,
            context: Context
          ): Record<string, unknown> =>
            Object.fromEntries(
              Object.entries(selected).map(([key, field]) => {
                if (is(field, Column)) {
                  const row = context.get(field.table as unknown as Table)
                  return [key, row ? (row[field.name] ?? null) : null]
                }
                if (is(field, Table)) {
                  const row = context.get(field)
                  return [
                    key,
                    row
                      ? project(getTableColumns(field) as Record<string, unknown>, context)
                      : null,
                  ]
                }
                if (is(field, SQL)) {
                  return [key, config.counts?.get(mainTable) ?? 0]
                }

                const nested = field as Record<string, Column>
                const firstColumn = Object.values(nested)[0]
                const sourceRow = firstColumn
                  ? context.get(firstColumn.table as unknown as Table)
                  : null
                return [key, sourceRow ? project(nested, context) : null]
              })
            )

          if (hasAggregate) return [project(selection, new Map())]
          return contexts.map((context) => project(selection, context))
        }

        const builder: any = {
          leftJoin: vi.fn((table: Table, on: SQL) => {
            joins.push({ table, on })
            return builder
          }),
          innerJoin: vi.fn((table: Table, on: SQL) => {
            joins.push({ table, on })
            return builder
          }),
          where: vi.fn(() => builder),
          orderBy: vi.fn(() => builder),
          limit: vi.fn(() => builder),
          offset: vi.fn(() => builder),
          then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve().then(evaluate).then(resolve, reject),
        }
        return builder
      }),
    })),
  }
  return db
}

async function runWithDb<T>(config: DrizzleMockConfig, run: () => Promise<T>) {
  const db = createDrizzleDbMock(config)
  vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any)
  return { result: await run(), db }
}

describe('dashboard-data: Drizzle 読み取り', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('getStreamerData', () => {
    it('配信者とカードを結合し、カードを作成日時の降順へ整列する', async () => {
      const { result, db } = await runWithDb(
        {
          tables: tableRows([
            [streamersTable, [STREAMER]],
            [cardsTable, [CARD_OLD, CARD_NEW]],
          ]),
        },
        () => getStreamerData('twitch-user-1')
      )

      expect(db.select).toHaveBeenCalledTimes(1)
      expect(result?.streamer).toEqual(STREAMER)
      expect(result?.cards.map((card) => card.id)).toEqual(['card-new', 'card-old'])
      expect('cards' in (result?.streamer ?? {})).toBe(false)
    })

    it('配信者が存在しない場合は null を返す', async () => {
      const { result } = await runWithDb(
        { tables: tableRows([[streamersTable, []]]) },
        () => getStreamerData('missing-user')
      )
      expect(result).toBeNull()
    })

    it('cards の新列が未デプロイなら安全な列集合で再試行する', async () => {
      const { result, db } = await runWithDb(
        {
          tables: tableRows([
            [streamersTable, [STREAMER]],
            [cardsTable, [CARD_NEW]],
          ]),
          errors: new Map([[streamersTable, [missingColumnError()]]]),
        },
        () => getStreamerData('twitch-user-1')
      )

      expect(result?.cards[0]).toMatchObject({ id: 'card-new', name: 'Card One' })
      expect(result?.cards[0]).not.toHaveProperty('hp')
      const lastSelection = db.select.mock.calls.at(-1)?.[0]
      expect(lastSelection?.card).toEqual(CARDS_SAFE_COLUMNS)
    })

    it('列欠落以外のDBエラーは null に落とす', async () => {
      const { result } = await runWithDb(
        {
          tables: tableRows([[streamersTable, [STREAMER]]]),
          errors: new Map([
            [streamersTable, [Object.assign(new Error('permission denied'), { code: '42501' })]],
          ]),
        },
        () => getStreamerData('twitch-user-1')
      )
      expect(result).toBeNull()
    })
  })

  describe('ページネーションと履歴', () => {
    it('配信者・カード・総件数からページ情報を作る', async () => {
      const { result } = await runWithDb(
        {
          tables: tableRows([
            [streamersTable, [STREAMER]],
            [cardsTable, [CARD_NEW, CARD_OLD]],
          ]),
          counts: new Map([[cardsTable, 3]]),
        },
        () => getStreamerDataPaginated('twitch-user-1', 2, 2)
      )

      expect(result).toEqual({
        streamer: STREAMER,
        cards: [CARD_NEW, CARD_OLD],
        pagination: { page: 2, perPage: 2, total: 3, totalPages: 2 },
      })
    })

    it('配信者がなければカードを問い合わせず null を返す', async () => {
      const { result, db } = await runWithDb(
        { tables: tableRows([[streamersTable, []]]) },
        () => getStreamerDataPaginated('missing-user')
      )
      expect(result).toBeNull()
      expect(db.select).toHaveBeenCalledTimes(1)
    })

    it('直近履歴へカードを単一オブジェクトとして埋め込む', async () => {
      const { result } = await runWithDb(
        {
          tables: tableRows([
            [gachaHistoryTable, [HISTORY_NEW, HISTORY_OLD]],
            [cardsTable, [CARD_NEW, CARD_OLD]],
          ]),
        },
        () => getRecentGachaHistory()
      )

      expect(result).toHaveLength(2)
      expect(result[0]).toMatchObject({ id: 'history-2', cards: { id: 'card-new' } })
      expect(typeof result[0].redeemed_at).toBe('string')
    })

    it('配信者履歴の行と総件数からページ情報を返す', async () => {
      const { result } = await runWithDb(
        {
          tables: tableRows([
            [gachaHistoryTable, [HISTORY_NEW]],
            [cardsTable, [CARD_NEW]],
          ]),
          counts: new Map([[gachaHistoryTable, 5]]),
        },
        () =>
          getGachaHistoryForStreamer('streamer-1', {
            page: 2,
            perPage: 2,
            username: 'viewer',
            rarity: 'rare',
            from: '2026-02-01',
            to: '2026-02-02',
          })
      )

      expect(result.history[0]).toMatchObject({
        id: 'history-2',
        cards: { id: 'card-new' },
      })
      expect(result.pagination).toEqual({ page: 2, perPage: 2, total: 5, totalPages: 3 })
    })

    it('履歴取得エラーは空のページへ正規化する', async () => {
      const { result } = await runWithDb(
        {
          tables: tableRows([[gachaHistoryTable, [HISTORY_NEW]]]),
          errors: new Map([
            [gachaHistoryTable, [Object.assign(new Error('denied'), { code: '42501' })]],
          ]),
        },
        () => getGachaHistoryForStreamer('streamer-1')
      )

      expect(result).toEqual({
        history: [],
        pagination: { page: 1, perPage: 20, total: 0, totalPages: 0 },
      })
    })

    it('ユーザー履歴へカードと配信者表示名を埋め込む', async () => {
      const { result } = await runWithDb(
        {
          tables: tableRows([
            [gachaHistoryTable, [HISTORY_OLD]],
            [cardsTable, [CARD_OLD]],
            [streamersTable, [STREAMER]],
          ]),
          counts: new Map([[gachaHistoryTable, 1]]),
        },
        () => getGachaHistoryForUser('viewer-1', { page: 1, perPage: 10 })
      )

      expect(result.history[0]).toMatchObject({
        id: 'history-1',
        cards: { id: 'card-old' },
        streamers: { twitch_display_name: 'Streamer One' },
      })
      expect(result.pagination).toEqual({ page: 1, perPage: 10, total: 1, totalPages: 1 })
    })
  })

  describe('カード・配信者の個別読み取り', () => {
    it('アクティブカードを返し、列欠落時は安全な列集合へ切り替える', async () => {
      const { result, db } = await runWithDb(
        {
          tables: tableRows([[cardsTable, [CARD_NEW]]]),
          errors: new Map([[cardsTable, [missingColumnError('skill_power')]]]),
        },
        () => getActiveCardsForStreamer('streamer-1')
      )

      expect(result[0]).toMatchObject({ id: 'card-new', drop_rate: 0.25 })
      expect(result[0]).not.toHaveProperty('skill_power')
      expect(db.select.mock.calls.at(-1)?.[0]).toEqual(CARDS_SAFE_COLUMNS)
    })

    it('複数配信者のアクティブカードを配信者ごとに集計する', async () => {
      const otherCard = makeCardRow({ id: 'card-other', streamer_id: 'streamer-2' })
      const { result } = await runWithDb(
        { tables: tableRows([[cardsTable, [CARD_OLD, CARD_NEW, otherCard]]]) },
        () => getActiveCardCountsForStreamers(['streamer-1', 'streamer-2'])
      )

      expect(result.get('streamer-1')).toEqual({
        totalActive: 2,
        activeCardIds: new Set(['card-old', 'card-new']),
      })
      expect(result.get('streamer-2')).toEqual({
        totalActive: 1,
        activeCardIds: new Set(['card-other']),
      })
    })

    it('IDで配信者を取得し、0行なら null を返す', async () => {
      const found = await runWithDb(
        { tables: tableRows([[streamersTable, [STREAMER]]]) },
        () => getStreamerById('streamer-1')
      )
      expect(found.result).toEqual(STREAMER)

      const missing = await runWithDb(
        { tables: tableRows([[streamersTable, []]]) },
        () => getStreamerById('missing')
      )
      expect(missing.result).toBeNull()
    })

    it('所有カードへ配信者と所持数を付与する', async () => {
      const { result } = await runWithDb(
        {
          tables: tableRows([
            [cardsTable, [CARD_OLD]],
            [streamersTable, [STREAMER]],
            [usersTable, [{ id: 'user-1', twitch_user_id: 'viewer-1' }]],
            [userCardsTable, []],
          ]),
          counts: new Map([[userCardsTable, 2]]),
        },
        () => getUserCardDetail('viewer-1', 'streamer-1', 'card-old')
      )

      expect(result).toMatchObject({
        id: 'card-old',
        count: 2,
        streamer: { id: 'streamer-1' },
        streamers: { id: 'streamer-1' },
      })
    })

    it('ユーザーがカードを所持していなければ null を返す', async () => {
      const { result } = await runWithDb(
        {
          tables: tableRows([
            [cardsTable, [CARD_OLD]],
            [streamersTable, [STREAMER]],
            [usersTable, [{ id: 'user-1', twitch_user_id: 'viewer-1' }]],
            [userCardsTable, []],
          ]),
          counts: new Map([[userCardsTable, 0]]),
        },
        () => getUserCardDetail('viewer-1', 'streamer-1', 'card-old')
      )
      expect(result).toBeNull()
    })
  })

  describe('getCollectionCompletions', () => {
    const completion = {
      total_cards: 10,
      completed_at: '2026-03-01T00:00:00.000+00:00',
      collection_name: '第一弾',
    }

    it('パック名を含む達成履歴を返す', async () => {
      const { result } = await runWithDb(
        { tables: tableRows([[collectionCompletionsTable, [completion]]]) },
        () => getCollectionCompletions('viewer-1', 'streamer-1')
      )
      expect(result).toEqual([completion])
    })

    it('collection_name 未デプロイ時は旧列で再取得して null を補完する', async () => {
      const { result, db } = await runWithDb(
        {
          tables: tableRows([[collectionCompletionsTable, [completion]]]),
          errors: new Map([[collectionCompletionsTable, [missingColumnError('collection_name')]]]),
        },
        () => getCollectionCompletions('viewer-1', 'streamer-1')
      )

      expect(result).toEqual([
        {
          total_cards: 10,
          completed_at: '2026-03-01T00:00:00.000+00:00',
          collection_name: null,
        },
      ])
      expect(db.select).toHaveBeenCalledTimes(2)
    })

    it('列欠落以外のDBエラーは空配列へ正規化する', async () => {
      const { result } = await runWithDb(
        {
          tables: tableRows([[collectionCompletionsTable, [completion]]]),
          errors: new Map([
            [collectionCompletionsTable, [Object.assign(new Error('denied'), { code: '42501' })]],
          ]),
        },
        () => getCollectionCompletions('viewer-1', 'streamer-1')
      )
      expect(result).toEqual([])
    })
  })
})
