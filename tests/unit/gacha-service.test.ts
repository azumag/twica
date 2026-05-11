import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GachaService } from '@/lib/services/gacha'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { createMockQueryBuilder } from '../utils/supabase-mock'

vi.mock('@/lib/supabase/admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/admin')>()
  return { ...actual, getSupabaseAdmin: vi.fn() }
})
vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn(),
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}))

const mockGetSupabaseAdmin = vi.mocked(getSupabaseAdmin)

// テスト用カードデータ
const testCards = [
  { id: 'card-1', name: 'Test Card', description: 'desc', image_url: null, rarity: 'common', drop_rate: 1.0 },
]

/** cardsクエリの共通モック生成。thenableにしてawait対応 */
function createCardsQuery(cards: typeof testCards | []) {
  const q = createMockQueryBuilder()
  ;(q as unknown as Record<string, unknown>).then = (resolve: (v: unknown) => void) => {
    resolve({ data: cards, error: null })
    return q
  }
  return q
}

describe('GachaService.executeGacha', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('正常系: RPC成功でカード結果を返す', async () => {
    const cardsQuery = createCardsQuery(testCards)
    const mockRpc = vi.fn().mockResolvedValue({
      data: { is_duplicate: false, history_id: 'h-1' },
      error: null,
    })

    // モック設定後にサービスを生成（コンストラクタでgetSupabaseAdminを呼ぶため）
    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'cards') return cardsQuery
        return createMockQueryBuilder()
      }),
      rpc: mockRpc,
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const service = new GachaService()
    const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-1')

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.card.id).toBe('card-1')
      expect(result.data.userTwitchUsername).toBe('testuser')
    }
    expect(mockRpc).toHaveBeenCalledWith('execute_gacha_transaction', {
      p_event_id: 'event-1',
      p_user_twitch_id: 'user-1',
      p_user_twitch_username: 'testuser',
      p_card_id: 'card-1',
      p_streamer_id: 'streamer-1',
      p_reward_cost: null,
    })
  })

  it('重複イベント: is_duplicate=true で Duplicate event エラーを返す', async () => {
    const cardsQuery = createCardsQuery(testCards)

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn(() => cardsQuery),
      rpc: vi.fn().mockResolvedValue({
        data: { is_duplicate: true },
        error: null,
      }),
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const service = new GachaService()
    const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-dup')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('Duplicate event')
    }
  })

  it('カード取得の一時的な502エラーをリトライして成功する', async () => {
    const failingCardsQuery = createMockQueryBuilder()
    ;(failingCardsQuery as unknown as Record<string, unknown>).then = (resolve: (v: unknown) => void) => {
      resolve({ data: null, error: { message: 'Database error: error code: 502', code: '502' } })
      return failingCardsQuery
    }
    const cardsQuery = createCardsQuery(testCards)
    const mockRpc = vi.fn().mockResolvedValue({
      data: { is_duplicate: false, history_id: 'h-retry-cards' },
      error: null,
    })
    const fromMock = vi.fn((table: string) => {
      if (table === 'cards') {
        return fromMock.mock.calls.filter(([name]) => name === 'cards').length === 1
          ? failingCardsQuery
          : cardsQuery
      }
      return createMockQueryBuilder()
    })

    mockGetSupabaseAdmin.mockReturnValue({
      from: fromMock,
      rpc: mockRpc,
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const service = new GachaService()
    const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-card-retry')

    expect(result.success).toBe(true)
    expect(fromMock).toHaveBeenCalledWith('cards')
    expect(fromMock).toHaveBeenCalledTimes(2)
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it('RPCの一時的な502エラーをリトライして成功する', async () => {
    const cardsQuery = createCardsQuery(testCards)
    const mockRpc = vi.fn()
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'Gacha RPC failed: error code: 502', code: '502' },
      })
      .mockResolvedValueOnce({
        data: { is_duplicate: false, history_id: 'h-retry-rpc' },
        error: null,
      })

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn(() => cardsQuery),
      rpc: mockRpc,
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const service = new GachaService()
    const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-rpc-retry')

    expect(result.success).toBe(true)
    expect(mockRpc).toHaveBeenCalledTimes(2)
  })

  it('RPC未デプロイ(42883): レガシーフォールバックで成功する', async () => {
    const cardsQuery = createCardsQuery(testCards)
    // フォールバック時のDB操作用モック（upsert → select → insert チェーン）
    const legacyQuery = createMockQueryBuilder()
    ;(legacyQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: 'user-1-uuid' }, error: null,
    })
    // insert (user_cards) のawait用thenable
    const insertQuery = createMockQueryBuilder()
    ;(insertQuery as unknown as Record<string, unknown>).then = (resolve: (v: unknown) => void) => {
      resolve({ data: null, error: null })
      return insertQuery
    }
    // upsert (gacha_history) のawait用thenable
    const upsertQuery = createMockQueryBuilder()
    ;(upsertQuery as unknown as Record<string, unknown>).then = (resolve: (v: unknown) => void) => {
      resolve({ data: null, error: null })
      return upsertQuery
    }

    const fromMock = vi.fn((table: string) => {
      if (table === 'cards') return cardsQuery
      if (table === 'gacha_history') return upsertQuery
      if (table === 'users') return legacyQuery
      if (table === 'user_cards') return insertQuery
      return createMockQueryBuilder()
    })

    mockGetSupabaseAdmin.mockReturnValue({
      from: fromMock,
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'function execute_gacha_transaction does not exist', code: '42883' },
      }),
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const service = new GachaService()
    const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-fallback')

    // フォールバックが成功してカードが返る
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.card.id).toBe('card-1')
    }
    // フォールバック時のDB操作が呼ばれている
    expect(fromMock).toHaveBeenCalledWith('gacha_history')
    expect(fromMock).toHaveBeenCalledWith('users')
  })

  it('RPCエラー(42883以外): reportErrorを呼びエラー結果を返す', async () => {
    const { reportError } = await import('@/lib/sentry/error-handler')
    const mockReportError = vi.mocked(reportError)
    const cardsQuery = createCardsQuery(testCards)

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn(() => cardsQuery),
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'connection refused', code: '08006' },
      }),
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const service = new GachaService()
    const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-err')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('connection refused')
    }
    expect(mockReportError).toHaveBeenCalled()
  })

  it('カード未登録: カードがない場合はエラーを返す', async () => {
    const cardsQuery = createCardsQuery([])

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn(() => cardsQuery),
      rpc: vi.fn(),
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const service = new GachaService()
    const result = await service.executeGacha('streamer-1', 'user-1', 'testuser')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('No cards available')
    }
  })

  it('eventId未指定: p_event_idにnullが渡される', async () => {
    const cardsQuery = createCardsQuery(testCards)
    const mockRpc = vi.fn().mockResolvedValue({
      data: { is_duplicate: false, history_id: 'h-2' },
      error: null,
    })

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn(() => cardsQuery),
      rpc: mockRpc,
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const service = new GachaService()
    await service.executeGacha('streamer-1', 'user-1', 'testuser')

    expect(mockRpc).toHaveBeenCalledWith('execute_gacha_transaction', expect.objectContaining({
      p_event_id: null,
    }))
  })
})

describe('GachaService.executeGachaForEventSub', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('追加報酬のDBエラーをReward ID mismatchに潰さず返す', async () => {
    const streamerQuery = createMockQueryBuilder()
    ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        id: 'streamer-1',
        channel_point_reward_id: 'main-reward',
        chat_announcement_enabled: false,
        chat_announcement_template: null,
      },
      error: null,
    })
    const additionalRewardQuery = createMockQueryBuilder()
    ;(additionalRewardQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: null,
      error: { message: 'Database error: error code: 502', code: '502' },
    })

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'streamers') return streamerQuery
        if (table === 'streamer_additional_gacha_rewards') return additionalRewardQuery
        return createMockQueryBuilder()
      }),
      rpc: vi.fn(),
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const service = new GachaService()
    const result = await service.executeGachaForEventSub({
      broadcaster_user_id: 'broadcaster-1',
      user_id: 'user-1',
      user_login: 'viewer',
      user_name: 'Viewer',
      reward: { id: 'additional-reward', cost: 100 },
    }, 'event-additional-db-error')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('Database error checking additional reward: Database error: error code: 502')
    }
  })

  it('streamer未登録: Streamer not foundを返す', async () => {
    const streamerQuery = createMockQueryBuilder()
    ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: null,
      error: null,
    })

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'streamers') return streamerQuery
        return createMockQueryBuilder()
      }),
      rpc: vi.fn(),
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const service = new GachaService()
    const result = await service.executeGachaForEventSub({
      broadcaster_user_id: 'missing-broadcaster',
      user_id: 'user-1',
      user_login: 'viewer',
      user_name: 'Viewer',
      reward: { id: 'reward-1', cost: 100 },
    }, 'event-missing-streamer')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('Streamer not found')
    }
  })

  it('streamer取得DBエラー: 未登録扱いにせずDBエラーを返す', async () => {
    const streamerQuery = createMockQueryBuilder()
    ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: null,
      error: { message: 'permission denied', code: '42501' },
    })

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'streamers') return streamerQuery
        return createMockQueryBuilder()
      }),
      rpc: vi.fn(),
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const service = new GachaService()
    const result = await service.executeGachaForEventSub({
      broadcaster_user_id: 'broadcaster-1',
      user_id: 'user-1',
      user_login: 'viewer',
      user_name: 'Viewer',
      reward: { id: 'reward-1', cost: 100 },
    }, 'event-streamer-db-error')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('Database error fetching streamer: permission denied')
    }
  })

  it('未設定のEventSub報酬はReward ID mismatchを返す', async () => {
    const streamerQuery = createMockQueryBuilder()
    ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        id: 'streamer-1',
        channel_point_reward_id: 'main-reward',
        chat_announcement_enabled: false,
        chat_announcement_template: null,
      },
      error: null,
    })
    const additionalRewardQuery = createMockQueryBuilder()
    ;(additionalRewardQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: null,
      error: null,
    })

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'streamers') return streamerQuery
        if (table === 'streamer_additional_gacha_rewards') return additionalRewardQuery
        return createMockQueryBuilder()
      }),
      rpc: vi.fn(),
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const service = new GachaService()
    const result = await service.executeGachaForEventSub({
      broadcaster_user_id: 'broadcaster-1',
      user_id: 'user-1',
      user_login: 'viewer',
      user_name: 'Viewer',
      reward: { id: 'stale-reward', cost: 100 },
    }, 'event-stale-reward')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('Reward ID mismatch')
    }
  })
})
