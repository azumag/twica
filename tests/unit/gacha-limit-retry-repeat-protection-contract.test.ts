import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GachaService } from '@/lib/services/gacha'
import { getDb } from '@/lib/db/client'
import { selectWeightedCardMinimizingRepeat } from '@/lib/gacha'

vi.mock('@/lib/db/client', () => ({ getDb: vi.fn() }))
vi.mock('@/lib/gacha', () => ({ selectWeightedCardMinimizingRepeat: vi.fn() }))
vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn(),
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}))

const mockGetDb = vi.mocked(getDb)
const mockSelectWeightedCardMinimizingRepeat = vi.mocked(selectWeightedCardMinimizingRepeat)

const cards = [
  {
    id: 'card-a',
    name: 'Card A',
    description: null,
    image_url: null,
    rarity: 'common',
    drop_rate: 1,
    max_issuance_count: null,
  },
  {
    id: 'card-b',
    name: 'Card B',
    description: null,
    image_url: null,
    rarity: 'common',
    drop_rate: 1,
    max_issuance_count: null,
  },
]

beforeEach(() => {
  vi.clearAllMocks()

  const builder: Record<string, unknown> = {}
  const chain = vi.fn(() => builder)
  Object.assign(builder, {
    from: chain,
    where: chain,
    then: (
      onFulfilled: (value: typeof cards) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(cards).then(onFulfilled, onRejected),
  })

  const select = vi.fn(() => builder)
  let transactionAttempt = 0
  const sql = vi.fn(() => {
    transactionAttempt += 1
    return Promise.resolve([{
      result: transactionAttempt === 1
        ? { limit_reached: true }
        : { is_duplicate: false, limit_reached: false, history_id: 'history-2' },
    }])
  })

  mockGetDb.mockResolvedValue({
    db: { select } as never,
    sql: sql as never,
  })
  mockSelectWeightedCardMinimizingRepeat.mockImplementation((pool) => pool[0] ?? null)
})

describe('GachaService limit_reached retry repeat protection (#1302)', () => {
  it('再抽選でも初回と同じ previousCardId を反復抑制抽選へ渡す', async () => {
    const result = await new GachaService().executeGacha(
      'streamer-1',
      'user-1',
      'Viewer',
      'event-1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'previous-card',
    )

    expect(result.success).toBe(true)
    expect(mockSelectWeightedCardMinimizingRepeat).toHaveBeenCalledTimes(2)
    expect(
      mockSelectWeightedCardMinimizingRepeat.mock.calls.map(([, previousCardId]) => previousCardId),
    ).toEqual(['previous-card', 'previous-card'])
    expect(
      mockSelectWeightedCardMinimizingRepeat.mock.calls.map(([pool]) => pool.map((card) => card.id)),
    ).toEqual([
      ['card-a', 'card-b'],
      ['card-b'],
    ])
  })
})
