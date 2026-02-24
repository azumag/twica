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
