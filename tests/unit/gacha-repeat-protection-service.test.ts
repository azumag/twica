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

interface FixtureOptions {
  latestCardId?: string | null
  latestHistoryError?: unknown
  additionalDrawCount?: number
}

/**
 * Issue #1296 の読み取り経路だけを再現する最小Drizzle fixture。
 * select fieldsを見て、同じgacha_historyテーブルの「N連完了prefix」と
 * 「直前カード1件」を区別する。
 */
function installDbFixture(options: FixtureOptions = {}) {
  const tableReads: string[] = []
  const transactionCalls: unknown[][] = []

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
          promise = Promise.resolve([])
        } else if (tableName === 'gacha_history' && 'card_id' in fields) {
          promise = options.latestHistoryError
            ? Promise.reject(options.latestHistoryError)
            : Promise.resolve(options.latestCardId
              ? [{ card_id: options.latestCardId }]
              : [])
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
    return Promise.resolve([{
      result: {
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
})
