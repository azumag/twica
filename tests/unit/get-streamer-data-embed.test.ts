/**
 * cards.streamer_id の外部キー関係が、
 * #803後もDrizzle LEFT JOINとして明示されることを確認する回帰テスト。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getStreamerData } from '@/lib/dashboard-data'
import { getDb } from '@/lib/db/client'
import {
  cards as cardsTable,
  streamers as streamersTable,
} from '@/lib/db/schema'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  return { ...actual, cache: (fn: unknown) => fn }
})

describe('getStreamerData streamers -> cards JOIN', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('cards.streamer_id 関係をLEFT JOINし、1クエリでstreamerとcardsを返す', async () => {
    const rows = [{
      streamer: {
        id: 's-1',
        twitch_user_id: 'twitch-1',
        twitch_username: 'streamer',
        twitch_display_name: 'Streamer',
      },
      card: null,
    }]
    const where = vi.fn().mockResolvedValue(rows)
    // vi.fn の引数型を明示し、呼び出し履歴を空 tuple と推論させない。
    // 第2引数は Drizzle の ON 条件であり、この回帰テストでは第1引数だけを検証する。
    const leftJoin = vi.fn<
      (_table: unknown, _on: unknown) => { where: typeof where }
    >(() => ({ where }))
    const from = vi.fn(() => ({ leftJoin }))
    const select = vi.fn(() => ({ from }))
    vi.mocked(getDb).mockResolvedValue({
      db: { select },
      sql: {},
    } as any)

    const result = await getStreamerData('twitch-1')

    expect(select).toHaveBeenCalledWith({
      streamer: streamersTable,
      card: cardsTable,
    })
    expect(from).toHaveBeenCalledWith(streamersTable)
    expect(leftJoin).toHaveBeenCalledOnce()
    expect(leftJoin.mock.calls[0][0]).toBe(cardsTable)
    expect(result).toEqual({
      streamer: rows[0].streamer,
      cards: [],
    })
  })
})
