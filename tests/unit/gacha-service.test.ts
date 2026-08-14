import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTableName } from 'drizzle-orm'
import { GachaService } from '@/lib/services/gacha'
import { getDb } from '@/lib/db/client'
import { reportError } from '@/lib/sentry/error-handler'
import { DEFAULT_PACK_SENTINEL } from '@/lib/validation/collection-name'
import { CARD_ISSUANCE_MESSAGES } from '@/lib/card-issuance'

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
const mockReportError = vi.mocked(reportError)

type QueueEntry<T> = { value?: T; error?: unknown }

interface DbFixture {
  tables?: Record<string, Array<QueueEntry<unknown[]>>>
  transactions?: Array<QueueEntry<{
    is_duplicate?: boolean
    limit_reached?: boolean
    history_id?: string | null
    cards?: unknown[]
  } | null>>
  issuedCounts?: Array<QueueEntry<Record<string, number> | null>>
}

/**
 * Drizzle の select builder と postgres.js の tagged-template SQL を再現する。
 *
 * 旧テストの PostgREST chain は、フィルターの記録だけで実際の実行境界が曖昧だった。
 * 現行実装では `db.select(...).from(table)...` と DB 関数 SQL が別経路なので、
 * テーブル単位の結果キューと関数単位の結果キューを明示的に分離する。各キューの
 * 最終要素を再利用する仕様は、N連ガチャで同じカード集合・成功結果を繰り返す
 * fixture を簡潔に表現しつつ、先頭要素をエラーにすれば接続再試行も検証できる。
 */
function installDbFixture(fixture: DbFixture = {}) {
  const tableCursors = new Map<string, number>()
  let transactionCursor = 0
  let issuedCountsCursor = 0

  function consume<T>(entries: Array<QueueEntry<T>> | undefined, cursor: number, fallback: T) {
    if (!entries || entries.length === 0) return { entry: { value: fallback }, next: cursor }
    const index = Math.min(cursor, entries.length - 1)
    return { entry: entries[index], next: cursor + 1 }
  }

  const select = vi.fn((fields: Record<string, unknown>) => {
    let tableName = ''
    const builder: Record<string, unknown> = {}
    const chain = vi.fn(() => builder)
    Object.assign(builder, {
      from: vi.fn((table: Parameters<typeof getTableName>[0]) => {
        tableName = getTableName(table)
        return builder
      }),
      where: chain,
      limit: chain,
      offset: chain,
      orderBy: chain,
      groupBy: chain,
      innerJoin: chain,
      leftJoin: chain,
      then: (
        onFulfilled: (value: unknown[]) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => {
        const cursor = tableCursors.get(tableName) ?? 0
        const consumed = consume(fixture.tables?.[tableName], cursor, [])
        tableCursors.set(tableName, consumed.next)
        const promise = consumed.entry.error
          ? Promise.reject(consumed.entry.error)
          : Promise.resolve(consumed.entry.value ?? [])
        return promise.then(onFulfilled, onRejected)
      },
    })
    void fields
    return builder
  })

  const transactionCalls: unknown[][] = []
  const issuedCountCalls: unknown[][] = []
  const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const statement = strings.join(' ')
    if (statement.includes('get_issued_card_counts')) {
      issuedCountCalls.push(values)
      const consumed = consume(fixture.issuedCounts, issuedCountsCursor, {})
      issuedCountsCursor = consumed.next
      if (consumed.entry.error) return Promise.reject(consumed.entry.error)
      return Promise.resolve([{ result: consumed.entry.value ?? {} }])
    }

    transactionCalls.push(values)
    const consumed = consume(
      fixture.transactions,
      transactionCursor,
      { is_duplicate: false, limit_reached: false, history_id: 'history-1' },
    )
    transactionCursor = consumed.next
    if (consumed.entry.error) return Promise.reject(consumed.entry.error)
    return Promise.resolve([{ result: consumed.entry.value ?? null }])
  })

  mockGetDb.mockResolvedValue({
    db: { select } as never,
    sql: sql as never,
  })

  return { select, sql, transactionCalls, issuedCountCalls, tableCursors }
}

function dbError(message: string, code: string) {
  return Object.assign(new Error(message), { code })
}

function omitIssuanceLimit<T extends { max_issuance_count?: unknown }>(card: T) {
  const { max_issuance_count: omitted, ...withoutIssuanceLimit } = card
  void omitted
  return withoutIssuanceLimit
}

/**
 * selectWeightedCard が使う secureRandomUnit（crypto.getRandomValues から
 * 53bit の [0,1) 一様乱数を合成する）を、指定したフラクション(f)を返すように
 * モックする。
 *
 * secureRandomUnit は Uint32Array(2) を 1 本引き、
 *   unit = ((buf[0] >>> 6) * 2^27 + (buf[1] >>> 5)) / 2^53
 * を返す。ここではその逆変換で 53bit 整数 f × 2^53 を上位 26bit / 下位 27bit へ
 * 分解して書き戻す。抽選側は「unit × プール重み合計」を閾値に使うため、
 * 呼び出し側は重みのスケール（旧実装の drop_rate × 10000 のような量子化単位）を
 * 意識する必要がない。
 */
function mockCryptoRandomFraction(fraction: number) {
  const scaled = Math.min(Math.floor(fraction * 0x20000000000000), 0x1fffffffffffff)
  const high = Math.floor(scaled / 0x8000000)
  const low = scaled % 0x8000000
  vi.spyOn(crypto, 'getRandomValues').mockImplementation((buf) => {
    // 対象は secureRandomUnit が使う Uint32Array(2) のみ
    if (buf instanceof Uint32Array && buf.length >= 2) {
      buf[0] = high << 6
      buf[1] = low << 5
    }
    return buf
  })
}

const testCards = [
  {
    id: 'card-1',
    name: 'Test Card',
    description: 'desc',
    image_url: null,
    rarity: 'common',
    collection_name: 'standard',
    drop_rate: 1,
    max_issuance_count: null,
  },
]

const persistedThreeDrawCards = [
  { ...testCards[0], id: 'card-1', name: 'First Card' },
  { ...testCards[0], id: 'card-2', name: 'Second Card' },
  { ...testCards[0], id: 'card-3', name: 'Third Card' },
]

const baseStreamer = {
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

const baseEvent = {
  broadcaster_user_id: 'broadcaster-1',
  user_id: 'user-1',
  user_login: 'viewer',
  user_name: 'Viewer',
  reward: { id: 'main-reward', cost: 100 },
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('GachaService.executeGacha: PlanetScale read/write', () => {
  it('カードをDrizzleで読み、名前付きSQL引数でトランザクションを実行する', async () => {
    const fixture = installDbFixture({ tables: { cards: [{ value: testCards }] } })

    const result = await new GachaService().executeGacha(
      'streamer-1', 'user-1', 'Viewer', 'event-1', 100, undefined, undefined, 'reward-1',
    )

    expect(result.success).toBe(true)
    expect(fixture.select).toHaveBeenCalledOnce()
    expect(Object.keys(fixture.select.mock.calls[0][0])).toContain('max_issuance_count')
    expect(fixture.transactionCalls[0]).toEqual([
      'event-1', 'user-1', 'Viewer', 'card-1', 'streamer-1', 100, 'reward-1',
      null, 1, 1, null,
    ])
  })

  it('eventId未指定時はSQLへnullを渡し、接続断を非冪等リトライしない', async () => {
    const connectionError = dbError('connection closed', 'CONNECTION_CLOSED')
    const fixture = installDbFixture({
      tables: { cards: [{ value: testCards }] },
      transactions: [
        { error: connectionError },
        { value: { is_duplicate: false, history_id: 'must-not-run' } },
      ],
    })

    const result = await new GachaService().executeGacha('streamer-1', 'user-1', 'Viewer')

    expect(result.success).toBe(false)
    expect(fixture.transactionCalls).toHaveLength(1)
    expect(fixture.transactionCalls[0][0]).toBeNull()
  })

  it('DECIMAL文字列のdrop_rateをnumberへ正規化する', async () => {
    installDbFixture({
      tables: {
        cards: [{ value: [{ ...testCards[0], drop_rate: '0.3000' }] }],
      },
    })

    const result = await new GachaService().executeGacha(
      'streamer-1', 'user-1', 'Viewer', 'event-decimal',
    )

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.card.drop_rate).toBe(0.3)
      expect(typeof result.data.card.drop_rate).toBe('number')
    }
  })

  it('重複イベントはカード付与成功として返さない', async () => {
    installDbFixture({
      tables: { cards: [{ value: testCards }] },
      transactions: [{ value: { is_duplicate: true } }],
    })

    const result = await new GachaService().executeGacha(
      'streamer-1', 'user-1', 'Viewer', 'event-duplicate',
    )

    expect(result).toEqual({ success: false, error: 'Duplicate event' })
  })

  it('カードreadの一時的な接続断をリトライする', async () => {
    const fixture = installDbFixture({
      tables: {
        cards: [
          { error: dbError('socket closed', 'CONNECTION_CLOSED') },
          { value: testCards },
        ],
      },
    })

    const result = await new GachaService().executeGacha(
      'streamer-1', 'user-1', 'Viewer', 'event-read-retry',
    )

    expect(result.success).toBe(true)
    expect(fixture.select).toHaveBeenCalledTimes(2)
  })

  it('eventIdがあるSQL書込みの一時的な接続断をリトライする', async () => {
    const fixture = installDbFixture({
      tables: { cards: [{ value: testCards }] },
      transactions: [
        { error: dbError('socket closed', 'CONNECTION_CLOSED') },
        { value: { is_duplicate: false, history_id: 'history-after-retry' } },
      ],
    })

    const result = await new GachaService().executeGacha(
      'streamer-1', 'user-1', 'Viewer', 'event-write-retry',
    )

    expect(result.success).toBe(true)
    expect(fixture.transactionCalls).toHaveLength(2)
  })

  it('必須DB関数が未デプロイなら別providerへ逃がさずfail-closedする', async () => {
    installDbFixture({
      tables: { cards: [{ value: testCards }] },
      transactions: [{ error: dbError('function does not exist', '42883') }],
    })

    const result = await new GachaService().executeGacha(
      'streamer-1', 'user-1', 'Viewer', 'event-function-missing',
    )

    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain('function does not exist')
    expect(mockReportError).toHaveBeenCalledOnce()
  })

  it('トランザクションのDBエラーを報告して呼出元へ返す', async () => {
    installDbFixture({
      tables: { cards: [{ value: testCards }] },
      transactions: [{ error: dbError('permission denied', '42501') }],
    })

    const result = await new GachaService().executeGacha(
      'streamer-1', 'user-1', 'Viewer', 'event-permission',
    )

    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain('permission denied')
    expect(mockReportError).toHaveBeenCalledOnce()
  })

  it('カードが0件ならSQL書込みを行わない', async () => {
    const fixture = installDbFixture({ tables: { cards: [{ value: [] }] } })

    const result = await new GachaService().executeGacha(
      'streamer-1', 'user-1', 'Viewer', 'event-no-cards',
    )

    expect(result.success).toBe(false)
    expect(fixture.transactionCalls).toHaveLength(0)
  })

  it('max_issuance_count列欠落時は列なしDrizzle readへフォールバックする', async () => {
    const fixture = installDbFixture({
      tables: {
        cards: [
          { error: dbError('column max_issuance_count does not exist', '42703') },
          { value: testCards.map(omitIssuanceLimit) },
        ],
      },
    })

    const result = await new GachaService().executeGacha(
      'streamer-1', 'user-1', 'Viewer', 'event-column-fallback',
    )

    expect(result.success).toBe(true)
    expect(fixture.select).toHaveBeenCalledTimes(2)
    expect(Object.keys(fixture.select.mock.calls[1][0])).not.toContain('max_issuance_count')
  })

  it('DrizzleQueryErrorのcauseにある列欠落もフォールバック対象にする', async () => {
    const wrapped = Object.assign(new Error('Failed query'), {
      cause: dbError('column max_issuance_count does not exist', '42703'),
    })
    const fixture = installDbFixture({
      tables: {
        cards: [
          { error: wrapped },
          { value: testCards.map(omitIssuanceLimit) },
        ],
      },
    })

    const result = await new GachaService().executeGacha(
      'streamer-1', 'user-1', 'Viewer', 'event-wrapped-column',
    )

    expect(result.success).toBe(true)
    expect(fixture.select).toHaveBeenCalledTimes(2)
  })

  it('発行上限到達カードを候補から除外する', async () => {
    const fixture = installDbFixture({
      tables: {
        cards: [{
          value: [
            { ...testCards[0], id: 'sold-out', max_issuance_count: 1, drop_rate: 100 },
            { ...testCards[0], id: 'available', max_issuance_count: null, drop_rate: 1 },
          ],
        }],
      },
      issuedCounts: [{ value: { 'sold-out': 1 } }],
    })

    const result = await new GachaService().executeGacha(
      'streamer-1', 'user-1', 'Viewer', 'event-limited',
    )

    expect(result.success).toBe(true)
    expect(fixture.issuedCountCalls[0][0]).toBe('sold-out')
    expect(fixture.transactionCalls[0][3]).toBe('available')
  })

  it('全カードが発行上限ならsoldOutを返して書込まない', async () => {
    const fixture = installDbFixture({
      tables: {
        cards: [{ value: [{ ...testCards[0], id: 'sold-out', max_issuance_count: 1 }] }],
      },
      issuedCounts: [{ value: { 'sold-out': 1 } }],
    })

    const result = await new GachaService().executeGacha(
      'streamer-1', 'user-1', 'Viewer', 'event-sold-out',
    )

    expect(result).toEqual({ success: false, error: CARD_ISSUANCE_MESSAGES.soldOut })
    expect(fixture.transactionCalls).toHaveLength(0)
  })

  it('発行数DB関数が未デプロイなら同じPlanetScaleのgroupBy集計を使う', async () => {
    const fixture = installDbFixture({
      tables: {
        cards: [{
          value: [
            { ...testCards[0], id: 'limited', max_issuance_count: 2 },
            { ...testCards[0], id: 'available', max_issuance_count: null },
          ],
        }],
        user_cards: [{ value: [{ cardId: 'limited', issuedCount: 2 }] }],
      },
      issuedCounts: [{ error: dbError('function missing', '42883') }],
    })

    const result = await new GachaService().executeGacha(
      'streamer-1', 'user-1', 'Viewer', 'event-count-fallback',
    )

    expect(result.success).toBe(true)
    expect(fixture.tableCursors.get('user_cards')).toBe(1)
    expect(fixture.transactionCalls[0][3]).toBe('available')
  })

  it('limit_reachedのカードを除外し同じeventIdで別カードを再抽選する', async () => {
    const fixture = installDbFixture({
      tables: {
        cards: [{
          value: [
            { ...testCards[0], id: 'card-a', drop_rate: 1 },
            { ...testCards[0], id: 'card-b', drop_rate: 1 },
          ],
        }],
      },
      transactions: [
        { value: { limit_reached: true } },
        { value: { is_duplicate: false, history_id: 'history-retry' } },
      ],
    })

    const result = await new GachaService().executeGacha(
      'streamer-1', 'user-1', 'Viewer', 'event-limit-retry',
    )

    expect(result.success).toBe(true)
    expect(fixture.transactionCalls).toHaveLength(2)
    expect(fixture.transactionCalls[1][3]).not.toBe(fixture.transactionCalls[0][3])
    expect(fixture.transactionCalls.map((call) => call[0])).toEqual([
      'event-limit-retry', 'event-limit-retry',
    ])
  })

  it('limit_reachedが全候補で続けばsoldOutを返す', async () => {
    const fixture = installDbFixture({
      tables: {
        cards: [{
          value: [
            { ...testCards[0], id: 'card-a' },
            { ...testCards[0], id: 'card-b' },
          ],
        }],
      },
      transactions: [{ value: { limit_reached: true } }],
    })

    const result = await new GachaService().executeGacha(
      'streamer-1', 'user-1', 'Viewer', 'event-exhausted',
    )

    expect(result).toEqual({ success: false, error: CARD_ISSUANCE_MESSAGES.soldOut })
    expect(fixture.transactionCalls).toHaveLength(2)
  })

  it('limit_reachedの再試行を5回で打ち切る', async () => {
    const fixture = installDbFixture({
      tables: {
        cards: [{
          value: Array.from({ length: 6 }, (_, index) => ({
            ...testCards[0],
            id: `card-${index}`,
          })),
        }],
      },
      transactions: [{ value: { limit_reached: true } }],
    })

    const result = await new GachaService().executeGacha(
      'streamer-1', 'user-1', 'Viewer', 'event-retry-cap',
    )

    expect(result).toEqual({ success: false, error: CARD_ISSUANCE_MESSAGES.soldOut })
    expect(fixture.transactionCalls).toHaveLength(5)
  })

  it.each([
    ['named pack', 'weapons'],
    ['default pack', DEFAULT_PACK_SENTINEL],
  ])('%sをDrizzle predicateで絞って抽選する', async (_label, collectionName) => {
    const fixture = installDbFixture({ tables: { cards: [{ value: testCards }] } })

    const result = await new GachaService().executeGacha(
      'streamer-1', 'user-1', 'Viewer', 'event-pack', 100, collectionName,
    )

    expect(result.success).toBe(true)
    expect(fixture.select).toHaveBeenCalledOnce()
    expect(Object.keys(fixture.select.mock.calls[0][0])).toContain('intra_rarity_weight')
  })

  it('collection未指定ではcollection列を選択せず、別列の42703を通常DBエラーとして返す', async () => {
    const fixture = installDbFixture({
      tables: {
        cards: [{ error: dbError('column cards.some_other_column does not exist', '42703') }],
      },
    })

    const result = await new GachaService().executeGacha(
      'streamer-1', 'user-1', 'Viewer', 'event-unrelated-column',
    )

    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain('Database error')
    expect(Object.keys(fixture.select.mock.calls[0][0])).not.toContain('intra_rarity_weight')
    expect(fixture.transactionCalls).toHaveLength(0)
  })

  it.each([DEFAULT_PACK_SENTINEL, 'weapons'])(
    'collection列未デプロイ時は全カード抽選へ落とさず拒否する: %s',
    async (collectionName) => {
      const fixture = installDbFixture({
        tables: {
          cards: [{ error: dbError('column cards.collection_name does not exist', '42703') }],
        },
      })

      const result = await new GachaService().executeGacha(
        'streamer-1', 'user-1', 'Viewer', 'event-pack-missing', 100, collectionName,
      )

      expect(result).toEqual({
        success: false,
        error: 'Card collections are not deployed yet',
      })
      expect(fixture.transactionCalls).toHaveLength(0)
    },
  )

  describe('パック内レアリティ自動配分', () => {
    const packCards = [
      { ...testCards[0], id: 'common-1', rarity: 'common', intra_rarity_weight: 1 },
      { ...testCards[0], id: 'common-2', rarity: 'common', intra_rarity_weight: 1 },
      { ...testCards[0], id: 'rare-1', rarity: 'rare', intra_rarity_weight: 1 },
    ]

    it.each([
      [0.35, 'common-2'],
      [0.65, 'rare-1'],
    ])('global重みの境界でカードを選ぶ: random=%s', async (random, expectedId) => {
      installDbFixture({ tables: { cards: [{ value: packCards }] } })
      // 有効重み合計 = common(0.3+0.3) + rare(0.4) = 1.0 → ×10000
      mockCryptoRandomFraction(random)

      const result = await new GachaService().executeGacha(
        'streamer-1',
        'user-1',
        'Viewer',
        'event-auto-weight',
        100,
        'weapons',
        {
          rarityWeightsScope: 'global',
          rarityWeights: { common: 60, rare: 40 },
          packRarityWeights: null,
        },
      )

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.card.id).toBe(expectedId)
        expect(result.data.card).not.toHaveProperty('intra_rarity_weight')
      }
    })

    it('手動モードはdrop_rateを使う', async () => {
      installDbFixture({
        tables: {
          cards: [{
            value: [
              { ...packCards[0], id: 'common', drop_rate: 0.9 },
              { ...packCards[2], id: 'rare', drop_rate: 0.1 },
            ],
          }],
        },
      })
      mockCryptoRandomFraction(0.92)

      const result = await new GachaService().executeGacha(
        'streamer-1', 'user-1', 'Viewer', 'event-manual', 100, 'weapons',
        { rarityWeightsScope: 'global', rarityWeights: null, packRarityWeights: null },
      )

      expect(result.success).toBe(true)
      if (result.success) expect(result.data.card.id).toBe('rare')
    })

    it('per_packは対象パックの上書きを優先する', async () => {
      installDbFixture({
        tables: {
          cards: [{
            value: [
              { ...packCards[0], id: 'common' },
              { ...packCards[2], id: 'rare' },
            ],
          }],
        },
      })
      mockCryptoRandomFraction(0.5)

      const result = await new GachaService().executeGacha(
        'streamer-1', 'user-1', 'Viewer', 'event-pack-weight', 100, DEFAULT_PACK_SENTINEL,
        {
          rarityWeightsScope: 'per_pack',
          rarityWeights: { common: 70, rare: 30 },
          packRarityWeights: {
            [DEFAULT_PACK_SENTINEL]: { common: 20, rare: 80 },
          },
        },
      )

      expect(result.success).toBe(true)
      if (result.success) expect(result.data.card.id).toBe('rare')
    })

    it('per_packに対象パックが無ければglobal重みを継承する', async () => {
      installDbFixture({ tables: { cards: [{ value: packCards }] } })
      mockCryptoRandomFraction(0.65)

      const result = await new GachaService().executeGacha(
        'streamer-1', 'user-1', 'Viewer', 'event-inherited-weight', 100, 'weapons',
        {
          rarityWeightsScope: 'per_pack',
          rarityWeights: { common: 60, rare: 40 },
          packRarityWeights: { characters: { common: 10, rare: 90 } },
        },
      )

      expect(result.success).toBe(true)
      if (result.success) expect(result.data.card.id).toBe('rare-1')
    })

    it('collection未指定ならweightsConfigを無視してdrop_rateで抽選する', async () => {
      installDbFixture({
        tables: {
          cards: [{
            value: [
              { ...testCards[0], id: 'common', rarity: 'common', drop_rate: 0.9 },
              { ...testCards[0], id: 'rare', rarity: 'rare', drop_rate: 0.1 },
            ],
          }],
        },
      })
      mockCryptoRandomFraction(0.92)

      const result = await new GachaService().executeGacha(
        'streamer-1', 'user-1', 'Viewer', 'event-unrestricted-weight', 100, null,
        {
          rarityWeightsScope: 'global',
          rarityWeights: { common: 95, rare: 5 },
          packRarityWeights: null,
        },
      )

      expect(result.success).toBe(true)
      if (result.success) expect(result.data.card.id).toBe('rare')
    })
  })
})

describe('GachaService.executeGachaForEventSub', () => {
  it('streamer未登録を明示する', async () => {
    installDbFixture({ tables: { streamers: [{ value: [] }] } })

    const result = await new GachaService().executeGachaForEventSub(baseEvent, 'event-no-streamer')

    expect(result).toEqual({ success: false, error: 'Streamer not found' })
  })

  it('streamer readエラーを未登録扱いにしない', async () => {
    installDbFixture({
      tables: {
        streamers: [{ error: dbError('permission denied', '42501') }],
      },
    })

    const result = await new GachaService().executeGachaForEventSub(baseEvent, 'event-streamer-error')

    expect(result).toEqual({
      success: false,
      error: 'Database error fetching streamer: permission denied',
    })
  })

  it('メイン報酬をカードへ付与しstreamer情報を返す', async () => {
    const fixture = installDbFixture({
      tables: {
        streamers: [{ value: [{ ...baseStreamer, channel_point_collection_name: 'weapons' }] }],
        cards: [{ value: testCards }],
      },
    })

    const result = await new GachaService().executeGachaForEventSub(baseEvent, 'event-main')

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.rewardId).toBe('main-reward')
      expect(result.data.collectionName).toBe('weapons')
      expect(result.data.streamer?.id).toBe('streamer-1')
    }
    expect(fixture.transactionCalls[0][6]).toBe('main-reward')
  })

  it('未設定報酬をReward ID mismatchとして拒否する', async () => {
    installDbFixture({
      tables: {
        streamers: [{ value: [baseStreamer] }],
        streamer_additional_gacha_rewards: [{ value: [] }],
      },
    })

    const result = await new GachaService().executeGachaForEventSub({
      ...baseEvent,
      reward: { id: 'unknown-reward', cost: 100 },
    }, 'event-mismatch')

    expect(result).toEqual({ success: false, error: 'Reward ID mismatch' })
  })

  it('追加報酬readエラーをmismatchへ潰さず返す', async () => {
    installDbFixture({
      tables: {
        streamers: [{ value: [baseStreamer] }],
        streamer_additional_gacha_rewards: [{
          error: dbError('permission denied', '42501'),
        }],
      },
    })

    const result = await new GachaService().executeGachaForEventSub({
      ...baseEvent,
      reward: { id: 'additional-reward', cost: 100 },
    }, 'event-additional-error')

    expect(result).toEqual({
      success: false,
      error: 'Database error checking additional reward: permission denied',
    })
  })

  it('追加報酬のraid option列欠落時は1回ガチャへ縮退しない', async () => {
    const fixture = installDbFixture({
      tables: {
        streamers: [{ value: [baseStreamer] }],
        streamer_additional_gacha_rewards: [{
          error: dbError('column draw_count does not exist', '42703'),
        }],
      },
    })

    const result = await new GachaService().executeGachaForEventSub({
      ...baseEvent,
      reward: { id: 'additional-reward', cost: 100 },
    }, 'event-options-missing')

    expect(result).toEqual({
      success: false,
      error: 'Additional reward options unavailable',
    })
    expect(fixture.transactionCalls).toHaveLength(0)
  })

  it('raid限定追加報酬は受付期限外なら発行しない', async () => {
    const fixture = installDbFixture({
      tables: {
        streamers: [{ value: [baseStreamer] }],
        streamer_additional_gacha_rewards: [{
          value: [{
            id: 'additional-1',
            draw_count: 2,
            is_raid_limited: true,
            collection_name: null,
          }],
        }],
      },
    })

    const result = await new GachaService().executeGachaForEventSub({
      ...baseEvent,
      reward: { id: 'additional-reward', cost: 100 },
    }, 'event-raid-inactive')

    expect(result).toEqual({ success: false, error: 'Raid-limited reward inactive' })
    expect(fixture.transactionCalls).toHaveLength(0)
  })

  it('raid限定追加報酬は受付期限内なら設定回数を発行する', async () => {
    const fixture = installDbFixture({
      tables: {
        streamers: [{
          value: [{
            ...baseStreamer,
            raid_gacha_active_until: '2999-01-01T00:00:00.000Z',
          }],
        }],
        streamer_additional_gacha_rewards: [{
          value: [{
            id: 'additional-raid',
            draw_count: 2,
            is_raid_limited: true,
            collection_name: null,
          }],
        }],
        gacha_history: [{ value: [] }],
        cards: [{ value: testCards }],
      },
    })

    const result = await new GachaService().executeGachaForEventSub({
      ...baseEvent,
      reward: { id: 'raid-reward', cost: 200 },
    }, 'event-raid-active')

    expect(result.success).toBe(true)
    if (result.success) expect(result.data.cards).toHaveLength(2)
    expect(fixture.transactionCalls).toHaveLength(2)
  })

  it('追加報酬のdraw_countだけN連し、reward costは先頭だけに保存する', async () => {
    const fixture = installDbFixture({
      tables: {
        streamers: [{ value: [baseStreamer] }],
        streamer_additional_gacha_rewards: [{
          value: [{
            id: 'additional-1',
            draw_count: 3,
            is_raid_limited: false,
            collection_name: 'characters',
          }],
        }],
        gacha_history: [{ value: [] }],
        cards: [{ value: testCards }],
      },
    })

    const result = await new GachaService().executeGachaForEventSub({
      ...baseEvent,
      reward: { id: 'additional-reward', cost: 300 },
    }, 'event-multi')

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cards).toHaveLength(3)
      expect(result.data.collectionName).toBe('characters')
    }
    expect(fixture.transactionCalls.map((call) => call[0])).toEqual([
      'event-multi', 'event-multi:2', 'event-multi:3',
    ])
    expect(fixture.transactionCalls.map((call) => call[5])).toEqual([300, null, null])
    expect(fixture.transactionCalls.map((call) => call[6])).toEqual([
      'additional-reward', 'additional-reward', 'additional-reward',
    ])
    // 同じEventSubバッチの各drawを、RPC内のchat outboxへ1-based index付きで
    // 原子的に保存する。パック名も全drawで同じ値をbindする。
    expect(fixture.transactionCalls.map((call) => call.slice(7, 11))).toEqual([
      ['event-multi', 1, 3, 'characters'],
      ['event-multi', 2, 3, 'characters'],
      ['event-multi', 3, 3, 'characters'],
    ])
  })

  it('全件完了済みのEventSub再送はDuplicate eventを返す', async () => {
    const fixture = installDbFixture({
      tables: {
        streamers: [{ value: [baseStreamer] }],
        streamer_additional_gacha_rewards: [{
          value: [{
            id: 'additional-1',
            draw_count: 2,
            is_raid_limited: false,
            collection_name: null,
          }],
        }],
        gacha_history: [{
          value: [{ event_id: 'event-done' }, { event_id: 'event-done:2' }],
        }],
      },
    })

    const result = await new GachaService().executeGachaForEventSub({
      ...baseEvent,
      reward: { id: 'additional-reward', cost: 200 },
    }, 'event-done')

    expect(result).toEqual({ success: false, error: 'Duplicate event' })
    expect(fixture.transactionCalls).toHaveLength(0)
  })

  it('一部完了済みの再送は残りだけ再開しreward costを二重保存しない', async () => {
    const fixture = installDbFixture({
      tables: {
        streamers: [{ value: [baseStreamer] }],
        streamer_additional_gacha_rewards: [{
          value: [{
            id: 'additional-1',
            draw_count: 3,
            is_raid_limited: false,
            collection_name: null,
          }],
        }],
        gacha_history: [{ value: [{ event_id: 'event-resume' }] }],
        cards: [{ value: testCards }],
      },
      transactions: [
        { value: { is_duplicate: false, history_id: 'second' } },
        {
          value: {
            is_duplicate: false,
            history_id: 'third',
            cards: persistedThreeDrawCards,
          },
        },
      ],
    })

    const result = await new GachaService().executeGachaForEventSub({
      ...baseEvent,
      reward: { id: 'additional-reward', cost: 300 },
    }, 'event-resume')

    expect(result.success).toBe(true)
    expect(fixture.transactionCalls.map((call) => call[0])).toEqual([
      'event-resume:2', 'event-resume:3',
    ])
    expect(fixture.transactionCalls.map((call) => call[5])).toEqual([null, null])
    if (result.success) {
      expect(result.data.cards).toEqual(persistedThreeDrawCards)
      expect(result.data.card).toEqual(persistedThreeDrawCards[0])
    }
  })

  it('N連先頭drawのCOMMIT後に応答を失ってもduplicate再試行から残りを完遂する', async () => {
    const fixture = installDbFixture({
      tables: {
        streamers: [{ value: [baseStreamer] }],
        streamer_additional_gacha_rewards: [{
          value: [{
            id: 'additional-1',
            draw_count: 3,
            is_raid_limited: false,
            collection_name: null,
          }],
        }],
        // 初回prefixは0。接続再試行がduplicateを返した後の再読込では、
        // 応答を失ったdraw1がcommit済みとして見える。
        gacha_history: [
          { value: [] },
          { value: [{ event_id: 'event-response-lost-first' }] },
        ],
        cards: [{ value: testCards }],
      },
      transactions: [
        { error: dbError('response lost after commit', 'CONNECTION_CLOSED') },
        { value: { is_duplicate: true } },
        { value: { is_duplicate: false, history_id: 'second' } },
        {
          value: {
            is_duplicate: false,
            history_id: 'third',
            cards: persistedThreeDrawCards,
          },
        },
      ],
    })

    const result = await new GachaService().executeGachaForEventSub({
      ...baseEvent,
      reward: { id: 'additional-reward', cost: 300 },
    }, 'event-response-lost-first')

    expect(result.success).toBe(true)
    expect(fixture.transactionCalls.map((call) => call[0])).toEqual([
      'event-response-lost-first',
      'event-response-lost-first',
      'event-response-lost-first:2',
      'event-response-lost-first:3',
    ])
    if (result.success) {
      expect(result.data.cards).toEqual(persistedThreeDrawCards)
    }
  })

  it('N連中間drawのCOMMIT後に応答を失ってもprefixを再読込して最終drawへ進む', async () => {
    const fixture = installDbFixture({
      tables: {
        streamers: [{ value: [baseStreamer] }],
        streamer_additional_gacha_rewards: [{
          value: [{
            id: 'additional-1',
            draw_count: 3,
            is_raid_limited: false,
            collection_name: null,
          }],
        }],
        gacha_history: [
          { value: [] },
          {
            value: [
              { event_id: 'event-response-lost-middle' },
              { event_id: 'event-response-lost-middle:2' },
            ],
          },
        ],
        cards: [{ value: testCards }],
      },
      transactions: [
        { value: { is_duplicate: false, history_id: 'first' } },
        { error: dbError('response lost after commit', 'CONNECTION_CLOSED') },
        { value: { is_duplicate: true } },
        {
          value: {
            is_duplicate: false,
            history_id: 'third',
            cards: persistedThreeDrawCards,
          },
        },
      ],
    })

    const result = await new GachaService().executeGachaForEventSub({
      ...baseEvent,
      reward: { id: 'additional-reward', cost: 300 },
    }, 'event-response-lost-middle')

    expect(result.success).toBe(true)
    expect(fixture.transactionCalls.map((call) => call[0])).toEqual([
      'event-response-lost-middle',
      'event-response-lost-middle:2',
      'event-response-lost-middle:2',
      'event-response-lost-middle:3',
    ])
    if (result.success) {
      expect(result.data.cards).toEqual(persistedThreeDrawCards)
    }
  })

  it('履歴が歯抜けなら先頭連続分の次から再開する', async () => {
    const fixture = installDbFixture({
      tables: {
        streamers: [{ value: [baseStreamer] }],
        streamer_additional_gacha_rewards: [{
          value: [{
            id: 'additional-1',
            draw_count: 3,
            is_raid_limited: false,
            collection_name: null,
          }],
        }],
        gacha_history: [{
          value: [{ event_id: 'event-gap' }, { event_id: 'event-gap:3' }],
        }],
        cards: [{ value: testCards }],
      },
      transactions: [
        { value: { is_duplicate: false, history_id: 'second' } },
        {
          value: {
            is_duplicate: true,
            cards: persistedThreeDrawCards,
          },
        },
      ],
    })

    const result = await new GachaService().executeGachaForEventSub({
      ...baseEvent,
      reward: { id: 'additional-reward', cost: 300 },
    }, 'event-gap')

    expect(result.success).toBe(true)
    expect(fixture.transactionCalls.map((call) => call[0])).toEqual([
      'event-gap:2', 'event-gap:3',
    ])
    if (result.success) {
      expect(result.data.cards).toEqual(persistedThreeDrawCards)
      expect(result.data.card).toEqual(persistedThreeDrawCards[0])
    }
  })

  it('履歴readエラーならカード発行前に停止する', async () => {
    const fixture = installDbFixture({
      tables: {
        streamers: [{ value: [baseStreamer] }],
        streamer_additional_gacha_rewards: [{
          value: [{
            id: 'additional-1',
            draw_count: 2,
            is_raid_limited: false,
            collection_name: null,
          }],
        }],
        gacha_history: [{ error: dbError('permission denied', '42501') }],
      },
    })

    const result = await new GachaService().executeGachaForEventSub({
      ...baseEvent,
      reward: { id: 'additional-reward', cost: 200 },
    }, 'event-history-error')

    expect(result).toEqual({
      success: false,
      error: 'Database error: permission denied',
    })
    expect(fixture.transactionCalls).toHaveLength(0)
  })

  it('N連途中の非重複エラーは部分成功をokとして返さない', async () => {
    installDbFixture({
      tables: {
        streamers: [{ value: [baseStreamer] }],
        streamer_additional_gacha_rewards: [{
          value: [{
            id: 'additional-1',
            draw_count: 2,
            is_raid_limited: false,
            collection_name: null,
          }],
        }],
        gacha_history: [{ value: [] }],
        cards: [{ value: testCards }],
      },
      transactions: [
        { value: { is_duplicate: false, history_id: 'first' } },
        { error: dbError('write denied', '42501') },
      ],
    })

    const result = await new GachaService().executeGachaForEventSub({
      ...baseEvent,
      reward: { id: 'additional-reward', cost: 200 },
    }, 'event-partial')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('Partial gacha completion: 1/2')
      expect(result.error).toContain('write denied')
    }
  })

  it('単発メイン報酬では完了履歴クエリを増やさない', async () => {
    const fixture = installDbFixture({
      tables: {
        streamers: [{ value: [baseStreamer] }],
        cards: [{ value: testCards }],
      },
    })

    const result = await new GachaService().executeGachaForEventSub(baseEvent, 'event-single')

    expect(result.success).toBe(true)
    expect(fixture.tableCursors.has('gacha_history')).toBe(false)
  })

  it('streamerのパック別レアリティ設定をメイン報酬の抽選へ伝播する', async () => {
    installDbFixture({
      tables: {
        streamers: [{
          value: [{
            ...baseStreamer,
            channel_point_collection_name: 'weapons',
            rarity_weights_scope: 'global',
            rarity_weights: { common: 20, rare: 80 },
          }],
        }],
        cards: [{
          value: [
            { ...testCards[0], id: 'common', rarity: 'common', intra_rarity_weight: 1 },
            { ...testCards[0], id: 'rare', rarity: 'rare', intra_rarity_weight: 1 },
          ],
        }],
      },
    })
    mockCryptoRandomFraction(0.5)

    const result = await new GachaService().executeGachaForEventSub(
      baseEvent,
      'event-main-weight',
    )

    expect(result.success).toBe(true)
    if (result.success) expect(result.data.card.id).toBe('rare')
  })
})

describe('GachaService.executeGachaForRaidEvent', () => {
  const raidEvent = {
    to_broadcaster_user_id: 'broadcaster-1',
    from_broadcaster_user_id: 'raider-1',
    from_broadcaster_user_login: 'raider_login',
    from_broadcaster_user_name: 'Raider',
  }

  it('設定回数分を送信者へ付与する', async () => {
    const fixture = installDbFixture({
      tables: {
        streamers: [{
          value: [{
            id: 'streamer-1',
            chat_announcement_enabled: true,
            chat_announcement_template: 'single',
            chat_announcement_multi_template: 'multi',
            chat_announcement_multi_show_cards: true,
            raid_gacha_draw_count: 2,
          }],
        }],
        gacha_history: [{ value: [] }],
        cards: [{ value: testCards }],
      },
    })

    const result = await new GachaService().executeGachaForRaidEvent(raidEvent, 'raid-event')

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cards).toHaveLength(2)
      expect(result.data.userTwitchUsername).toBe('Raider')
      expect(result.data.streamer?.id).toBe('streamer-1')
    }
    expect(fixture.transactionCalls.map((call) => call[0])).toEqual([
      'raid-event', 'raid-event:2',
    ])
  })

  it('0回設定ならカード発行しない', async () => {
    const fixture = installDbFixture({
      tables: {
        streamers: [{
          value: [{
            id: 'streamer-1',
            chat_announcement_enabled: false,
            chat_announcement_template: null,
            chat_announcement_multi_template: null,
            chat_announcement_multi_show_cards: true,
            raid_gacha_draw_count: 0,
          }],
        }],
      },
    })

    const result = await new GachaService().executeGachaForRaidEvent(raidEvent, 'raid-disabled')

    expect(result).toEqual({ success: false, error: 'Raid gacha disabled' })
    expect(fixture.transactionCalls).toHaveLength(0)
  })

  it('streamer readエラー・未登録は同じ安全なnot-found契約にする', async () => {
    installDbFixture({
      tables: {
        streamers: [{ error: dbError('permission denied', '42501') }],
      },
    })

    const result = await new GachaService().executeGachaForRaidEvent(raidEvent, 'raid-error')

    expect(result).toEqual({ success: false, error: 'Streamer not found' })
  })
})
