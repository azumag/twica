import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getTableName, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { GachaService } from '@/lib/services/gacha'
import { getDb } from '@/lib/db/client'
import { DEFAULT_PACK_SENTINEL } from '@/lib/validation/collection-name'
import { mockSecureRandomUnit } from '../utils/secure-random'

// Issue #1994: 1つのチャネルポイント報酬に複数パックを割り当てたときの抽選経路。
// gacha-service.test.ts の fixture は WHERE 条件を記録しないため、このファイルでは
// select ごとの「テーブル・選択列・WHERE 条件（SQL にレンダリング）」を記録し、
// 0/1/2+ パックの経路分岐とパック条件を実 SQL で検証する。

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
const dialect = new PgDialect()

type QueueEntry = { value?: unknown[]; error?: unknown }

interface RecordedSelect {
  table: string
  fields: string[]
  where: { sql: string; params: unknown[] } | null
}

function installDbFixture(tables: Record<string, QueueEntry[]>) {
  const cursors = new Map<string, number>()
  const selects: RecordedSelect[] = []
  const transactionCalls: unknown[][] = []

  const select = vi.fn((fields: Record<string, unknown>) => {
    const record: RecordedSelect = { table: '', fields: Object.keys(fields), where: null }
    selects.push(record)
    const builder: Record<string, unknown> = {}
    const chain = vi.fn(() => builder)
    Object.assign(builder, {
      from: vi.fn((table: Parameters<typeof getTableName>[0]) => {
        record.table = getTableName(table)
        return builder
      }),
      where: vi.fn((predicate: SQL | undefined) => {
        if (predicate) {
          const { sql, params } = dialect.sqlToQuery(predicate)
          record.where = { sql, params }
        }
        return builder
      }),
      limit: chain,
      orderBy: chain,
      then: (onFulfilled: (value: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) => {
        const queue = tables[record.table] ?? []
        const cursor = cursors.get(record.table) ?? 0
        cursors.set(record.table, cursor + 1)
        const entry = queue.length === 0 ? { value: [] } : queue[Math.min(cursor, queue.length - 1)]
        const promise = entry.error ? Promise.reject(entry.error) : Promise.resolve(entry.value ?? [])
        return promise.then(onFulfilled, onRejected)
      },
    })
    return builder
  })

  const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const statement = strings.join(' ')
    if (statement.includes('get_issued_card_counts')) {
      return Promise.resolve([{ result: {} }])
    }
    transactionCalls.push(values)
    return Promise.resolve([{ result: { is_duplicate: false, limit_reached: false, history_id: 'h' } }])
  })

  mockGetDb.mockResolvedValue({ db: { select } as never, sql: sql as never })
  return { selects, transactionCalls }
}

function missingColumn(column: string) {
  return Object.assign(new Error(`column streamers.${column} does not exist`), { code: '42703' })
}

/** execute_gacha_transaction_with_chat_outbox の名前付き引数の並び（gacha.ts）。 */
const RPC_ARG = { cardId: 3, collectionName: 10 } as const

const baseCard = {
  description: null,
  image_url: null,
  image_padding_color: null,
  drop_rate: 1,
  max_issuance_count: null,
  intra_rarity_weight: 1,
}

const baseStreamer = {
  id: 'streamer-1',
  channel_point_reward_id: 'main-reward',
  channel_point_collection_name: null as string | null,
  channel_point_pack_names: [] as string[],
  chat_announcement_enabled: false,
  chat_announcement_template: null,
  chat_announcement_multi_template: null,
  chat_announcement_multi_show_cards: true,
  raid_gacha_active_until: null,
  rarity_weights: null as Record<string, number> | null,
  rarity_weights_scope: null as string | null,
  pack_rarity_weights: null as Record<string, Record<string, number>> | null,
  default_card_pack_name: null,
}

const baseEvent = {
  broadcaster_user_id: 'broadcaster-1',
  user_id: 'user-1',
  user_login: 'viewer',
  user_name: 'Viewer',
  reward: { id: 'main-reward', cost: 100 },
}

const cardsSelect = (selects: RecordedSelect[]) => selects.filter((s) => s.table === 'cards')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('executeGachaForEventSub: main reward pack scope (Issue #1994)', () => {
  it('0 packs (array [] + legacy null) draws from all cards without a collection predicate', async () => {
    const fixture = installDbFixture({
      streamers: [{ value: [baseStreamer] }],
      cards: [{ value: [{ ...baseCard, id: 'c1', name: 'C1', rarity: 'common' }] }],
    })

    const result = await new GachaService().executeGachaForEventSub({ event: baseEvent, eventId: 'e0' })

    expect(result.success).toBe(true)
    if (result.success) expect(result.data.collectionName).toBeNull()
    const [cards] = cardsSelect(fixture.selects)
    expect(cards.where?.sql).not.toContain('collection_name')
    expect(cards.fields).not.toContain('intra_rarity_weight')
    expect(fixture.transactionCalls[0][RPC_ARG.collectionName]).toBeNull()
  })

  it('1 pack keeps the legacy single-pack path (eq predicate, collectionName passed to the RPC)', async () => {
    const fixture = installDbFixture({
      streamers: [{ value: [{ ...baseStreamer, channel_point_collection_name: 'weapons', channel_point_pack_names: ['weapons'] }] }],
      cards: [{ value: [{ ...baseCard, id: 'c1', name: 'C1', rarity: 'common' }] }],
    })

    const result = await new GachaService().executeGachaForEventSub({ event: baseEvent, eventId: 'e1' })

    expect(result.success).toBe(true)
    if (result.success) expect(result.data.collectionName).toBe('weapons')
    const [cards] = cardsSelect(fixture.selects)
    expect(cards.where?.sql).toContain('"cards"."collection_name" = $')
    expect(cards.where?.params).toContain('weapons')
    expect(cards.fields).toContain('intra_rarity_weight')
    expect(fixture.transactionCalls[0][RPC_ARG.collectionName]).toBe('weapons')
  })

  it('legacy-only rows (array []) still resolve to the single pack (no backfill needed)', async () => {
    const fixture = installDbFixture({
      streamers: [{ value: [{ ...baseStreamer, channel_point_collection_name: 'weapons', channel_point_pack_names: [] }] }],
      cards: [{ value: [{ ...baseCard, id: 'c1', name: 'C1', rarity: 'common' }] }],
    })

    await new GachaService().executeGachaForEventSub({ event: baseEvent, eventId: 'e1b' })

    expect(cardsSelect(fixture.selects)[0].where?.params).toContain('weapons')
    expect(fixture.transactionCalls[0][RPC_ARG.collectionName]).toBe('weapons')
  })

  it('2+ packs draw from the union (IN) and pass collectionName=null to the RPC and result', async () => {
    const fixture = installDbFixture({
      streamers: [{
        value: [{
          ...baseStreamer,
          channel_point_collection_name: 'weapons',
          channel_point_pack_names: ['weapons', 'characters'],
        }],
      }],
      cards: [{ value: [{ ...baseCard, id: 'c1', name: 'C1', rarity: 'common' }] }],
    })

    const result = await new GachaService().executeGachaForEventSub({ event: baseEvent, eventId: 'e2' })

    expect(result.success).toBe(true)
    if (result.success) expect(result.data.collectionName).toBeNull()
    const [cards] = cardsSelect(fixture.selects)
    expect(cards.where?.sql).toContain('"cards"."collection_name" in ($')
    expect(cards.where?.params).toEqual(expect.arrayContaining(['weapons', 'characters']))
    // 和集合でもパック内レアリティ自動配分の計算に intra_rarity_weight が必要。
    expect(cards.fields).toContain('intra_rarity_weight')
    // {packName} は当たったカード自身のパックから解決するため、抽選スコープは null。
    expect(fixture.transactionCalls[0][RPC_ARG.collectionName]).toBeNull()
  })

  it('expands __default__ to OR IS NULL in the union predicate', async () => {
    const fixture = installDbFixture({
      streamers: [{
        value: [{
          ...baseStreamer,
          channel_point_collection_name: 'weapons',
          channel_point_pack_names: ['weapons', DEFAULT_PACK_SENTINEL],
        }],
      }],
      cards: [{ value: [{ ...baseCard, id: 'c1', name: 'C1', rarity: 'common' }] }],
    })

    await new GachaService().executeGachaForEventSub({ event: baseEvent, eventId: 'e3' })

    const [cards] = cardsSelect(fixture.selects)
    expect(cards.where?.sql).toContain('"cards"."collection_name" is null')
    expect(cards.where?.sql).toContain(' or ')
    expect(cards.where?.params).not.toContain(DEFAULT_PACK_SENTINEL)
  })

  it('lets the legacy column win when it disagrees with the array head (rollback safety)', async () => {
    const fixture = installDbFixture({
      streamers: [{
        value: [{
          ...baseStreamer,
          channel_point_collection_name: 'other',
          channel_point_pack_names: ['weapons', 'characters'],
        }],
      }],
      cards: [{ value: [{ ...baseCard, id: 'c1', name: 'C1', rarity: 'common' }] }],
    })

    await new GachaService().executeGachaForEventSub({ event: baseEvent, eventId: 'e4' })

    expect(cardsSelect(fixture.selects)[0].where?.params).toContain('other')
    expect(fixture.transactionCalls[0][RPC_ARG.collectionName]).toBe('other')
  })

  // デプロイ窓: アプリが先に動き、新列がまだ無い。全引き換えを止めず旧単一列で抽選する。
  it('re-reads the streamer without the new column when it is missing (42703) and uses the legacy column', async () => {
    const fixture = installDbFixture({
      streamers: [
        { error: missingColumn('channel_point_pack_names') },
        { value: [{ ...baseStreamer, channel_point_collection_name: 'weapons', channel_point_pack_names: undefined }] },
      ],
      cards: [{ value: [{ ...baseCard, id: 'c1', name: 'C1', rarity: 'common' }] }],
    })

    const result = await new GachaService().executeGachaForEventSub({ event: baseEvent, eventId: 'e5' })

    expect(result.success).toBe(true)
    const streamerSelects = fixture.selects.filter((s) => s.table === 'streamers')
    expect(streamerSelects).toHaveLength(2)
    expect(streamerSelects[0].fields).toContain('channel_point_pack_names')
    expect(streamerSelects[1].fields).not.toContain('channel_point_pack_names')
    expect(cardsSelect(fixture.selects)[0].where?.params).toContain('weapons')
  })

  it('does not swallow unrelated streamer read errors', async () => {
    installDbFixture({
      streamers: [{ error: missingColumn('some_other_column') }],
    })

    const result = await new GachaService().executeGachaForEventSub({ event: baseEvent, eventId: 'e6' })

    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain('Database error fetching streamer')
  })
})

describe('executeGachaForEventSub: additional reward pack scope (Issue #1994)', () => {
  const additionalEvent = { ...baseEvent, reward: { id: 'additional-reward', cost: 300 } }

  it('2+ packs draw every card of the batch from the union and pass collectionName=null', async () => {
    const fixture = installDbFixture({
      streamers: [{ value: [baseStreamer] }],
      streamer_additional_gacha_rewards: [{
        value: [{
          id: 'a1',
          draw_count: 2,
          is_raid_limited: false,
          collection_name: 'weapons',
          reward_pack_names: ['weapons', 'characters'],
        }],
      }],
      cards: [{ value: [{ ...baseCard, id: 'c1', name: 'C1', rarity: 'common' }] }],
    })

    const result = await new GachaService().executeGachaForEventSub({ event: additionalEvent, eventId: 'ea' })

    expect(result.success).toBe(true)
    if (result.success) expect(result.data.collectionName).toBeNull()
    const cardReads = cardsSelect(fixture.selects)
    expect(cardReads).toHaveLength(2)
    for (const read of cardReads) {
      expect(read.where?.sql).toContain('"cards"."collection_name" in ($')
    }
    expect(fixture.transactionCalls.map((call) => call[RPC_ARG.collectionName])).toEqual([null, null])
  })

  it('1 pack keeps the single-pack path for additional rewards', async () => {
    const fixture = installDbFixture({
      streamers: [{ value: [baseStreamer] }],
      streamer_additional_gacha_rewards: [{
        value: [{ id: 'a1', draw_count: 1, is_raid_limited: false, collection_name: 'characters', reward_pack_names: [] }],
      }],
      cards: [{ value: [{ ...baseCard, id: 'c1', name: 'C1', rarity: 'common' }] }],
    })

    const result = await new GachaService().executeGachaForEventSub({ event: additionalEvent, eventId: 'eb' })

    expect(result.success).toBe(true)
    if (result.success) expect(result.data.collectionName).toBe('characters')
    expect(fixture.transactionCalls[0][RPC_ARG.collectionName]).toBe('characters')
  })

  it('re-reads the additional reward without reward_pack_names when that column is missing (42703)', async () => {
    const fixture = installDbFixture({
      streamers: [{ value: [baseStreamer] }],
      streamer_additional_gacha_rewards: [
        { error: Object.assign(new Error('column streamer_additional_gacha_rewards.reward_pack_names does not exist'), { code: '42703' }) },
        { value: [{ id: 'a1', draw_count: 1, is_raid_limited: false, collection_name: 'characters' }] },
      ],
      cards: [{ value: [{ ...baseCard, id: 'c1', name: 'C1', rarity: 'common' }] }],
    })

    const result = await new GachaService().executeGachaForEventSub({ event: additionalEvent, eventId: 'ec' })

    expect(result.success).toBe(true)
    const rewardReads = fixture.selects.filter((s) => s.table === 'streamer_additional_gacha_rewards')
    expect(rewardReads).toHaveLength(2)
    expect(rewardReads[0].fields).toContain('reward_pack_names')
    expect(rewardReads[1].fields).not.toContain('reward_pack_names')
    expect(fixture.transactionCalls[0][RPC_ARG.collectionName]).toBe('characters')
  })
})

describe('rarity weights for a 2+ pack union (Issue #1994)', () => {
  const unionCards = [
    { ...baseCard, id: 'common', name: 'Common', rarity: 'common', collection_name: 'weapons' },
    { ...baseCard, id: 'rare', name: 'Rare', rarity: 'rare', collection_name: 'characters' },
  ]

  it('applies the GLOBAL rarityWeights to the union even when scope is per_pack (pack overrides ignored)', async () => {
    const fixture = installDbFixture({
      streamers: [{
        value: [{
          ...baseStreamer,
          channel_point_collection_name: 'weapons',
          channel_point_pack_names: ['weapons', 'characters'],
          rarity_weights_scope: 'per_pack',
          rarity_weights: { common: 10, rare: 90 },
          // パック別上書き（common を極端に優遇）が使われていれば common が当たる。
          pack_rarity_weights: { weapons: { common: 99, rare: 1 }, characters: { common: 99, rare: 1 } },
        }],
      }],
      cards: [{ value: unionCards }],
    })
    // 実効重み: common 0.1 / rare 0.9。0.5 は rare の区間に入る。
    mockSecureRandomUnit(0.5)

    const result = await new GachaService().executeGachaForEventSub({ event: baseEvent, eventId: 'w1' })

    expect(result.success).toBe(true)
    expect(fixture.transactionCalls[0][RPC_ARG.cardId]).toBe('rare')
  })

  it('keeps manual mode (rarityWeights null) on renormalized drop_rate for the union', async () => {
    const fixture = installDbFixture({
      streamers: [{
        value: [{
          ...baseStreamer,
          channel_point_collection_name: 'weapons',
          channel_point_pack_names: ['weapons', 'characters'],
          rarity_weights_scope: 'per_pack',
          rarity_weights: null,
          pack_rarity_weights: { weapons: { common: 1, rare: 99 } },
        }],
      }],
      cards: [{
        value: [
          { ...unionCards[0], drop_rate: 0.9 },
          { ...unionCards[1], drop_rate: 0.1 },
        ],
      }],
    })
    // drop_rate 正規化後: common 0.9 / rare 0.1。0.5 は common の区間に入る。
    mockSecureRandomUnit(0.5)

    await new GachaService().executeGachaForEventSub({ event: baseEvent, eventId: 'w2' })

    expect(fixture.transactionCalls[0][RPC_ARG.cardId]).toBe('common')
  })

  it('still uses the per_pack override for a single pack (unchanged path)', async () => {
    const fixture = installDbFixture({
      streamers: [{
        value: [{
          ...baseStreamer,
          channel_point_collection_name: 'weapons',
          channel_point_pack_names: ['weapons'],
          rarity_weights_scope: 'per_pack',
          rarity_weights: { common: 10, rare: 90 },
          pack_rarity_weights: { weapons: { common: 99, rare: 1 } },
        }],
      }],
      cards: [{ value: unionCards }],
    })
    mockSecureRandomUnit(0.5)

    await new GachaService().executeGachaForEventSub({ event: baseEvent, eventId: 'w3' })

    expect(fixture.transactionCalls[0][RPC_ARG.cardId]).toBe('common')
  })
})
