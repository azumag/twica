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
  { id: 'card-1', name: 'Test Card', description: 'desc', image_url: null, rarity: 'common', drop_rate: 1.0, max_issuance_count: null },
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

  it('発行上限に達したカードを抽選候補から除外する', async () => {
    const cardsQuery = createCardsQuery([
      { id: 'sold-out-card', name: 'Sold Out', description: null, image_url: null, rarity: 'legendary', drop_rate: 100, max_issuance_count: 1 },
      { id: 'available-card', name: 'Available', description: null, image_url: null, rarity: 'common', drop_rate: 1, max_issuance_count: null },
    ] as typeof testCards)
    const userCardsQuery = createMockQueryBuilder()
    ;(userCardsQuery as unknown as Record<string, unknown>).then = (resolve: (v: unknown) => void) => {
      resolve({ data: [{ card_id: 'sold-out-card' }], error: null })
      return userCardsQuery
    }
    const mockRpc = vi.fn().mockResolvedValue({
      data: { is_duplicate: false, limit_reached: false, history_id: 'h-1' },
      error: null,
    })

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'cards') return cardsQuery
        if (table === 'user_cards') return userCardsQuery
        return createMockQueryBuilder()
      }),
      rpc: mockRpc,
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const service = new GachaService()
    const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-limited')

    expect(result.success).toBe(true)
    expect(mockRpc).toHaveBeenCalledWith('execute_gacha_transaction', expect.objectContaining({
      p_card_id: 'available-card',
    }))
  })

  it('全カードが発行上限に達している場合はエラーを返す', async () => {
    const cardsQuery = createCardsQuery([
      { id: 'sold-out-card', name: 'Sold Out', description: null, image_url: null, rarity: 'legendary', drop_rate: 100, max_issuance_count: 1 },
    ] as typeof testCards)
    const userCardsQuery = createMockQueryBuilder()
    ;(userCardsQuery as unknown as Record<string, unknown>).then = (resolve: (v: unknown) => void) => {
      resolve({ data: [{ card_id: 'sold-out-card' }], error: null })
      return userCardsQuery
    }
    const mockRpc = vi.fn()

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'cards') return cardsQuery
        if (table === 'user_cards') return userCardsQuery
        return createMockQueryBuilder()
      }),
      rpc: mockRpc,
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const service = new GachaService()
    const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-sold-out')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('発行可能枚数')
    }
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('RPCが発行上限到達を返した場合はカード付与成功にしない', async () => {
    const cardsQuery = createCardsQuery(testCards)
    const mockRpc = vi.fn().mockResolvedValue({
      data: { is_duplicate: false, limit_reached: true },
      error: null,
    })

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn(() => cardsQuery),
      rpc: mockRpc,
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const service = new GachaService()
    const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-race')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('発行可能枚数')
    }
  })

  it('RPC未デプロイ + limited カード選択時: legacy パスで発行を拒否する', async () => {
    // limited カード (max_issuance_count あり) を含むカード集合で、
    // RPC が未デプロイ (42883) でフォールバックが必要な状況をシミュレートする。
    // selectWeightedCard が limited カードを選んだケースを再現するため、
    // 抽選候補に未発行の limited カードのみを残す。
    const limitedCards = [
      { id: 'limited-card', name: 'Limited', description: 'desc', image_url: null, rarity: 'legendary', drop_rate: 100, max_issuance_count: 5 },
    ]
    const cardsQuery = createCardsQuery(limitedCards as unknown as typeof testCards)
    // user_cards は未発行 (0/5) → limited カードが抽選対象に残る
    const userCardsQuery = createMockQueryBuilder()
    ;(userCardsQuery as unknown as Record<string, unknown>).then = (resolve: (v: unknown) => void) => {
      resolve({ data: [], error: null })
      return userCardsQuery
    }

    const fromMock = vi.fn((table: string) => {
      if (table === 'cards') return cardsQuery
      if (table === 'user_cards') return userCardsQuery
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
    const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-legacy-limited')

    // Legacy パスでは atomic な発行枚数チェックができないため、
    // 上限超過リスクを避けて soldOut エラーを返す。
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('発行可能枚数')
    }
    // gacha_history / user_cards INSERT は実行されていないことを確認
    expect(fromMock).not.toHaveBeenCalledWith('gacha_history')
    expect(fromMock).not.toHaveBeenCalledWith('users')
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
