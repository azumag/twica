import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTableName } from 'drizzle-orm'
import { GachaService } from '@/lib/services/gacha'
import { getDb } from '@/lib/db/client'
import { mockSecureRandomUnit } from '../utils/secure-random'

vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn(),
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}))

vi.mock('@/lib/db/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/client')>()
  return { ...actual, getDb: vi.fn() }
})

const mockGetDb = vi.mocked(getDb)

const cards = [
  {
    id: 'card-a',
    name: 'Card A',
    description: null,
    image_url: null,
    image_padding_color: null,
    rarity: 'common',
    collection_name: null,
    drop_rate: 0.5,
    max_issuance_count: null,
  },
  {
    id: 'card-b',
    name: 'Card B',
    description: null,
    image_url: null,
    image_padding_color: null,
    rarity: 'common',
    collection_name: null,
    drop_rate: 0.5,
    max_issuance_count: null,
  },
]

const streamer = {
  id: 'streamer-1',
  channel_point_reward_id: 'main-reward',
  channel_point_collection_name: null,
  chat_announcement_enabled: false,
  chat_announcement_template: null,
  chat_announcement_multi_template: null,
  chat_announcement_multi_show_cards: true,
  raid_gacha_active_until: null,
  rarity_weights: null,
  rarity_weights_scope: null,
  pack_rarity_weights: null,
  default_card_pack_name: null,
}

interface TransactionResult {
  is_duplicate?: boolean
  limit_reached?: boolean
  history_id?: string | null
  cards?: typeof cards
}

interface FixtureOptions {
  latestCardId?: string | null
  latestCardIds?: Array<string | null>
  latestHistoryError?: unknown
  completedPrefixes?: Array<Array<{ event_id: string }>>
  additionalDrawCount?: number
  transactions?: Array<{ result?: TransactionResult; error?: unknown }>
}

function consume<T>(values: T[] | undefined, index: number, fallback: T): T {
  if (!values || values.length === 0) return fallback
  return values[Math.min(index, values.length - 1)]
}

/**
 * Issue #1296 の読み取り経路だけを再現する最小Drizzle fixture。
 * select fieldsを見て、同じgacha_historyテーブルの「N連完了prefix」と
 * 「直前カード1件」を区別する。
 */
function installDbFixture(options: FixtureOptions = {}) {
  const tableReads: string[] = []
  const transactionCalls: unknown[][] = []
  let latestCardCursor = 0
  let completedPrefixCursor = 0
  let transactionCursor = 0

  const select = vi.fn((fields: Record<string, unknown>) => {
    let tableName = ''
    const builder: Record<string, unknown> = {}
    const chain = vi.fn(() => builder)

    Object.assign(builder, {
      from: vi.fn((table: Parameters<typeof getTableName>[0]) => {
        tableName = getTableName(table)
        tableReads.push(tableName)
        return builder
      }),
      where: chain,
      limit: chain,
      orderBy: chain,
      then: (
        onFulfilled: (value: unknown[]) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => {
        let promise: Promise<unknown[]>
        if (tableName === 'gacha_history' && 'event_id' in fields) {
          const prefix = consume(options.completedPrefixes, completedPrefixCursor, [])
          completedPrefixCursor += 1
          promise = Promise.resolve(prefix)
        } else if (tableName === 'gacha_history' && 'card_id' in fields) {
          if (options.latestHistoryError) {
            promise = Promise.reject(options.latestHistoryError)
          } else {
            const latestCardId = options.latestCardIds
              ? consume(options.latestCardIds, latestCardCursor, null)
              : options.latestCardId ?? null
            latestCardCursor += 1
            promise = Promise.resolve(latestCardId ? [{ card_id: latestCardId }] : [])
          }
        } else if (tableName === 'cards') {
          promise = Promise.resolve(cards)
        } else if (tableName === 'streamers') {
          promise = Promise.resolve([streamer])
        } else if (tableName === 'streamer_additional_gacha_rewards') {
          promise = Promise.resolve(options.additionalDrawCount
            ? [{
                id: 'additional-1',
                draw_count: options.additionalDrawCount,
                is_raid_limited: false,
                collection_name: null,
              }]
            : [])
        } else {
          promise = Promise.resolve([])
        }
        return promise.then(onFulfilled, onRejected)
      },
    })

    return builder
  })

  const sql = vi.fn((_strings: TemplateStringsArray, ...values: unknown[]) => {
    transactionCalls.push(values)
    const configured = consume(options.transactions, transactionCursor, {
      result: {
        is_duplicate: false,
        limit_reached: false,
        history_id: `history-${transactionCalls.length}`,
      },
    })
    transactionCursor += 1
    if (configured.error) return Promise.reject(configured.error)
    return Promise.resolve([{
      result: configured.result ?? {
        is_duplicate: false,
        limit_reached: false,
        history_id: `history-${transactionCalls.length}`,
      },
    }])
  })

  mockGetDb.mockResolvedValue({
    db: { select } as never,
    sql: sql as never,
  })

  return { tableReads, transactionCalls }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GachaService repeat protection', () => {
  it('pack-scoped rarity実効重みでも直前カードの反復抑制を適用する', () => {
    const service = new GachaService()
    mockSecureRandomUnit(0)

    const pool = [
      {
        id: 'common-heavy-raw',
        name: 'Common',
        description: null,
        image_url: null,
        image_padding_color: null,
        rarity: 'common' as const,
        drop_rate: 0.99,
        max_issuance_count: null,
      },
      {
        id: 'rare-light-raw',
        name: 'Rare',
        description: null,
        image_url: null,
        image_padding_color: null,
        rarity: 'rare' as const,
        drop_rate: 0.01,
        max_issuance_count: null,
      },
    ]

    // 生drop_rateの99:1ではfraction=0のとき直前commonを再度選ぶが、
    // pack-scoped自動配分の50:50 effectiveWeightなら反復ゼロの境界になりrareへ移る。
    // resolvedRarityWeightsを使う分岐でも #1296 の反復抑制が失われないことを固定する。
    const selected = (service as any).selectCardFromPool(
      pool,
      { common: 50, rare: 50 },
      'common-heavy-raw',
    )

    expect(selected?.id).toBe('rare-light-raw')
    // effectiveWeightは選択専用で、返却カードの永続drop_rateへ漏らさない。
    expect(selected?.drop_rate).toBe(0.01)
  })

  it('最新履歴のカードを直前状態として使い、同確率2枚の連続を避ける', async () => {
    const fixture = installDbFixture({ latestCardId: 'card-a' })
    mockSecureRandomUnit(0)

    const result = await new GachaService().executeGachaWithRepeatProtection(
      'streamer-1',
      'user-1',
      'Viewer',
      'event-1',
    )

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.card.id).toBe('card-b')
    }
    expect(fixture.transactionCalls).toHaveLength(1)
    expect(fixture.transactionCalls[0][3]).toBe('card-b')
    expect(fixture.tableReads.filter((table) => table === 'gacha_history')).toHaveLength(1)
  })

  it('redeemed_atがNULLの履歴しかなくても、従来の独立抽選へ安全にフォールバックする', async () => {
    // getLatestCardIdForStreamer は redeemed_at IS NOT NULL で候補を絞るため、
    // legacy NULL 行しかない状態は「有効な最新履歴0件」として返る契約を再現する。
    const fixture = installDbFixture({ latestCardId: null })
    mockSecureRandomUnit(0)

    const result = await new GachaService().executeGachaWithRepeatProtection(
      'streamer-1',
      'user-1',
      'Viewer',
      'event-empty-history',
    )

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.card.id).toBe('card-a')
    }
    expect(fixture.transactionCalls).toHaveLength(1)
    expect(fixture.transactionCalls[0][3]).toBe('card-a')
    expect(fixture.tableReads.filter((table) => table === 'gacha_history')).toHaveLength(1)
  })

  it('最新履歴の読み取りに失敗しても、従来の独立抽選へフォールバックする', async () => {
    const fixture = installDbFixture({
      latestHistoryError: new Error('history read unavailable'),
    })
    mockSecureRandomUnit(0)

    const result = await new GachaService().executeGachaWithRepeatProtection(
      'streamer-1',
      'user-1',
      'Viewer',
      'event-fallback',
    )

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.card.id).toBe('card-a')
    }
    expect(fixture.transactionCalls[0][3]).toBe('card-a')
  })

  it('limit_reached 再抽選でも同じ直前カード状態を維持する', async () => {
    const fixture = installDbFixture({
      latestCardId: 'card-a',
      transactions: [
        { result: { is_duplicate: false, limit_reached: true, history_id: null } },
        { result: { is_duplicate: false, limit_reached: false, history_id: 'history-2' } },
      ],
    })
    mockSecureRandomUnit(0)

    const service = new GachaService()
    const selectSpy = vi.spyOn(service as any, 'selectCardFromPool')
    const result = await service.executeGachaWithRepeatProtection(
      'streamer-1',
      'user-1',
      'Viewer',
      'event-limit-retry',
    )

    expect(result.success).toBe(true)
    expect(fixture.transactionCalls.map((call) => call[3])).toEqual(['card-b', 'card-a'])
    expect(selectSpy.mock.calls.map((call) => call[2])).toEqual(['card-a', 'card-a'])
    expect(fixture.tableReads.filter((table) => table === 'gacha_history')).toHaveLength(1)
  })

  it('N連では履歴を冒頭に1回だけ読み、以後は直前の確定結果を引き継ぐ', async () => {
    const fixture = installDbFixture({
      latestCardId: 'card-a',
      additionalDrawCount: 3,
    })
    mockSecureRandomUnit(0)

    const result = await new GachaService().executeGachaForEventSub({
      broadcaster_user_id: 'broadcaster-1',
      user_id: 'user-1',
      user_login: 'viewer',
      user_name: 'Viewer',
      reward: { id: 'multi-reward', cost: 300 },
    }, 'event-multi')

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cards?.map((card) => card.id)).toEqual([
        'card-b',
        'card-a',
        'card-b',
      ])
    }
    expect(fixture.transactionCalls.map((call) => call[3])).toEqual([
      'card-b',
      'card-a',
      'card-b',
    ])
    // N連prefix確認 + 直前カード取得。各ドローごとの追加履歴readは発生しない。
    expect(fixture.tableReads.filter((table) => table === 'gacha_history')).toHaveLength(2)
  })

  it('N連のCOMMIT応答消失後はDBの最新カードへ再同期して次drawの連続を避ける', async () => {
    const persistedCards = [cards[1], cards[0], cards[1]]
    const fixture = installDbFixture({
      latestCardIds: ['card-a', 'card-b'],
      completedPrefixes: [
        [],
        [{ event_id: 'event-ambiguous' }],
      ],
      additionalDrawCount: 3,
      transactions: [
        {
          error: Object.assign(new Error('response lost after commit'), {
            code: 'CONNECTION_CLOSED',
          }),
        },
        { result: { is_duplicate: true } },
        { result: { is_duplicate: false, history_id: 'history-2' } },
        {
          result: {
            is_duplicate: false,
            history_id: 'history-3',
            cards: persistedCards,
          },
        },
      ],
    })
    mockSecureRandomUnit(0)

    const result = await new GachaService().executeGachaForEventSub({
      broadcaster_user_id: 'broadcaster-1',
      user_id: 'user-1',
      user_login: 'viewer',
      user_name: 'Viewer',
      reward: { id: 'multi-reward', cost: 300 },
    }, 'event-ambiguous')

    expect(result.success).toBe(true)
    expect(fixture.transactionCalls.map((call) => call[3])).toEqual([
      'card-b',
      'card-b',
      'card-a',
      'card-b',
    ])
    if (result.success) {
      expect(result.data.cards?.map((card) => card.id)).toEqual([
        'card-b',
        'card-a',
        'card-b',
      ])
    }
    // prefix初回 + 最新カード初回 + duplicate後prefix再読込 + 最新カード再同期。
    expect(fixture.tableReads.filter((table) => table === 'gacha_history')).toHaveLength(4)
  })
})
