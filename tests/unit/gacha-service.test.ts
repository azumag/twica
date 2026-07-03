import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { GachaService } from '@/lib/services/gacha'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { createMockQueryBuilder } from '../utils/supabase-mock'
import { DEFAULT_PACK_SENTINEL } from '@/lib/validation/collection-name'
import { CARD_ISSUANCE_MESSAGES } from '@/lib/card-issuance'

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
  { id: 'card-1', name: 'Test Card', description: 'desc', image_url: null, rarity: 'common', collection_name: 'standard', drop_rate: 1.0, max_issuance_count: null },
]

/** cardsクエリの共通モック生成。thenableにしてawait対応 */
function createCardsQuery<T extends Record<string, unknown>>(cards: T[]) {
  const q = createMockQueryBuilder()
  ;(q as unknown as Record<string, unknown>).then = (resolve: (v: unknown) => void) => {
    resolve({ data: cards, error: null })
    return q
  }
  return q
}

/**
 * rpc() の共通モック。Issue #548 以降、発行上限付きカードがあると
 * executeGacha は execute_gacha_transaction とは別に get_issued_card_counts も
 * 呼ぶため、単純な単一 mockResolvedValue では両者を区別できない。
 * 呼ばれた関数名(第1引数)で振り分け、get_issued_card_counts には
 * issuedCounts (card_id -> 発行済み枚数のプレーンオブジェクト、
 * get_issued_card_counts RPC の実際の戻り値と同じ形)を返す。
 * execute_gacha_transaction は呼ばれるたびに transactionResponses を
 * 1つずつ消費し、最後の要素は使い切った後も繰り返し返す
 * (`mockResolvedValue` と同じ「以降は同じ値」の挙動)。
 */
function createRpcMock(options: {
  issuedCounts?: Record<string, number>
  transactionResponses: Array<{ data: unknown; error: { message: string; code?: string } | null }>
}) {
  const { issuedCounts = {}, transactionResponses } = options
  let callIndex = 0
  // 第2引数(params)を明示的にシグネチャへ含める: これが無いと vi.fn() の型が
  // 1要素タプル([fnName: string])に推論され、呼び出し側で
  // `mock.calls[n][1]` (params) にアクセスするコードが型エラーになる。
  // params 自体はこのモックの分岐に使わないため、`void` で参照だけして
  // no-unused-vars を満たす(呼び出し側の型安全性のためだけに存在する引数)。
  return vi.fn((fnName: string, params?: Record<string, unknown>) => {
    void params
    if (fnName === 'get_issued_card_counts') {
      return Promise.resolve({ data: issuedCounts, error: null })
    }
    const response = transactionResponses[Math.min(callIndex, transactionResponses.length - 1)]
    callIndex += 1
    return Promise.resolve(response)
  })
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

  it('drop_rate が DECIMAL 文字列で返っても、結果カードの drop_rate は number に正規化される', async () => {
    // Supabase JS client は DECIMAL(5,4) を文字列で返す場合がある
    // (normalizeDropRate の存在理由)。返却カードを生 rows から再構築する
    // 実装(#579)でも、正規化済み配列を参照して string が GachaResult /
    // overlay broadcast へ漏れないことを担保する回帰テスト。
    const stringDropRateCards = [
      { id: 'card-1', name: 'Test Card', description: 'desc', image_url: null, rarity: 'common', drop_rate: '0.3000' as unknown as number },
    ]
    const cardsQuery = createCardsQuery(stringDropRateCards)
    const mockRpc = vi.fn().mockResolvedValue({
      data: { is_duplicate: false, history_id: 'h-1' },
      error: null,
    })

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
      expect(result.data.card.drop_rate).toBe(0.3)
      expect(typeof result.data.card.drop_rate).toBe('number')
    }
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
    const mockRpc = createRpcMock({
      issuedCounts: { 'sold-out-card': 1 },
      transactionResponses: [{ data: { is_duplicate: false, limit_reached: false, history_id: 'h-1' }, error: null }],
    })

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => (table === 'cards' ? cardsQuery : createMockQueryBuilder())),
      rpc: mockRpc,
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const service = new GachaService()
    const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-limited')

    expect(result.success).toBe(true)
    expect(mockRpc).toHaveBeenCalledWith('execute_gacha_transaction', expect.objectContaining({
      p_card_id: 'available-card',
    }))
  })

  it('発行枚数チェックRPCは limitedCards のIDのみに絞り込む（無制限カードIDを含まない）', async () => {
    const cardsQuery = createCardsQuery([
      { id: 'unlimited-card', name: 'Unlimited', description: null, image_url: null, rarity: 'common', drop_rate: 1, max_issuance_count: null },
      { id: 'limited-card', name: 'Limited', description: null, image_url: null, rarity: 'rare', drop_rate: 1, max_issuance_count: 5 },
    ] as typeof testCards)
    const mockRpc = createRpcMock({
      transactionResponses: [{ data: { is_duplicate: false, history_id: 'h-1' }, error: null }],
    })

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => (table === 'cards' ? cardsQuery : createMockQueryBuilder())),
      rpc: mockRpc,
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    await new GachaService().executeGacha('streamer-1', 'user-1', 'testuser', 'event-query-scope')

    // get_issued_card_counts RPC は limitedCards の ID のみで呼ばれる(無制限カードIDを含まない)
    expect(mockRpc).toHaveBeenCalledWith('get_issued_card_counts', { p_card_ids: ['limited-card'] })
  })

  it('全カードが発行上限に達している場合はエラーを返す', async () => {
    const cardsQuery = createCardsQuery([
      { id: 'sold-out-card', name: 'Sold Out', description: null, image_url: null, rarity: 'legendary', drop_rate: 100, max_issuance_count: 1 },
    ] as typeof testCards)
    const mockRpc = createRpcMock({
      issuedCounts: { 'sold-out-card': 1 },
      transactionResponses: [],
    })

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => (table === 'cards' ? cardsQuery : createMockQueryBuilder())),
      rpc: mockRpc,
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const service = new GachaService()
    const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-sold-out')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('発行可能枚数')
    }
    // 発行枚数チェックRPC (get_issued_card_counts) は呼ばれるが、全カード売り切れのため
    // 抽選トランザクションRPC (execute_gacha_transaction) は呼ばれない
    expect(mockRpc).not.toHaveBeenCalledWith('execute_gacha_transaction', expect.anything())
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
    // 上限超過リスクを避けて拒否する。R2 (PR #450 follow-up): この拒否は
    // 本物の soldOut とは別の異常系(RPC未デプロイ)なので、専用の
    // limitUnavailable を返し、genuine soldOut の文字列とは区別される
    // (eventsub route.ts のソフトフェイル抑止に巻き込まれずreportErrorが
    // 発火することを別テストで検証する)。
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe(CARD_ISSUANCE_MESSAGES.limitUnavailable)
      expect(result.error).not.toBe(CARD_ISSUANCE_MESSAGES.soldOut)
    }
    // gacha_history / user_cards INSERT は実行されていないことを確認
    expect(fromMock).not.toHaveBeenCalledWith('gacha_history')
    expect(fromMock).not.toHaveBeenCalledWith('users')
  })

  // R1 (PR #450 レビュー follow-up): limit_reached はプール全体の抽選失敗ではなく、
  // 選ばれたカードだけを除外して残りプールから再抽選すべき。migration 00067 が
  // gacha_history INSERT より前に limit_reached を返すことを利用し、同じ eventId
  // でRPCを再実行しても副作用が無いことに依拠する(gacha.ts のコメント参照)。
  describe('limit_reached 時の再抽選 (R1)', () => {
    it('limit_reachedを受けたカードをプールから除外し、別カードで同じeventIdでRPCを再実行して成功する', async () => {
      const cardsQuery = createCardsQuery([
        { id: 'card-a', name: 'A', description: null, image_url: null, rarity: 'common', drop_rate: 0.5, max_issuance_count: null },
        { id: 'card-b', name: 'B', description: null, image_url: null, rarity: 'common', drop_rate: 0.5, max_issuance_count: null },
      ] as unknown as typeof testCards)
      const mockRpc = vi.fn()
        .mockResolvedValueOnce({ data: { is_duplicate: false, limit_reached: true }, error: null })
        .mockResolvedValueOnce({ data: { is_duplicate: false, limit_reached: false, history_id: 'h-retry' }, error: null })

      mockGetSupabaseAdmin.mockReturnValue({
        from: vi.fn((table: string) => (table === 'cards' ? cardsQuery : createMockQueryBuilder())),
        rpc: mockRpc,
      } as unknown as ReturnType<typeof getSupabaseAdmin>)

      const service = new GachaService()
      const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-retry')

      expect(result.success).toBe(true)
      expect(mockRpc).toHaveBeenCalledTimes(2)
      const firstCardId = (mockRpc.mock.calls[0][1] as { p_card_id: string }).p_card_id
      const secondCardId = (mockRpc.mock.calls[1][1] as { p_card_id: string }).p_card_id
      // 2回目は1回目と別のカードが選ばれている(除外が効いている)
      expect(secondCardId).not.toBe(firstCardId)
      // 同じ eventId が両方の呼び出しに渡されている(副作用ゼロなので安全に同一eventIdで再試行できる)
      expect((mockRpc.mock.calls[0][1] as { p_event_id: string }).p_event_id).toBe('event-retry')
      expect((mockRpc.mock.calls[1][1] as { p_event_id: string }).p_event_id).toBe('event-retry')
      if (result.success) {
        expect(result.data.card.id).toBe(secondCardId)
      }
    })

    it('パック内自動配分(effectiveWeight)でも limit_reached 後に残りプールから正しく再選択する', async () => {
      // 発行上限付き(c1)+無制限(c2)の2枚パック。c1がまず選ばれてlimit_reachedに
      // なっても、effectiveWeightの再計算を経てc2で成功することを確認する。
      const packCards = [
        { id: 'c1', name: 'Common1', description: null, image_url: null, rarity: 'common', collection_name: 'weapons', drop_rate: 1.0, intra_rarity_weight: 1.0, max_issuance_count: 1 },
        { id: 'c2', name: 'Common2', description: null, image_url: null, rarity: 'common', collection_name: 'weapons', drop_rate: 1.0, intra_rarity_weight: 1.0, max_issuance_count: null },
      ]
      const cardsQuery = createCardsQuery(packCards as unknown as typeof testCards)
      // c1はまだ未発行(0/1)なので発行上限フィルタ後も初期プールに残る
      const mockRpc = createRpcMock({
        issuedCounts: {},
        transactionResponses: [
          { data: { is_duplicate: false, limit_reached: true }, error: null },
          { data: { is_duplicate: false, limit_reached: false, history_id: 'h-effective-retry' }, error: null },
        ],
      })

      mockGetSupabaseAdmin.mockReturnValue({
        from: vi.fn((table: string) => (table === 'cards' ? cardsQuery : createMockQueryBuilder())),
        rpc: mockRpc,
      } as unknown as ReturnType<typeof getSupabaseAdmin>)

      const service = new GachaService()
      const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-effective-retry', 100, 'weapons', {
        rarityWeightsScope: 'global',
        rarityWeights: { common: 100 },
        packRarityWeights: null,
      })

      expect(result.success).toBe(true)
      // 発行枚数チェックRPCの1回 + 抽選トランザクションRPCの2回(1回目はlimit_reached)
      const transactionCalls = mockRpc.mock.calls.filter(([fnName]) => fnName === 'execute_gacha_transaction')
      expect(transactionCalls).toHaveLength(2)
      const firstCardId = (transactionCalls[0][1] as { p_card_id: string }).p_card_id
      const secondCardId = (transactionCalls[1][1] as { p_card_id: string }).p_card_id
      expect(secondCardId).not.toBe(firstCardId)
      if (result.success) {
        expect(result.data.card.id).toBe(secondCardId)
      }
    })

    it('全カードでlimit_reachedが続く場合はプールを使い果たしてsoldOutを返す', async () => {
      const cardsQuery = createCardsQuery([
        { id: 'card-a', name: 'A', description: null, image_url: null, rarity: 'common', drop_rate: 0.5, max_issuance_count: 1 },
        { id: 'card-b', name: 'B', description: null, image_url: null, rarity: 'common', drop_rate: 0.5, max_issuance_count: 1 },
      ] as unknown as typeof testCards)
      // 両カードとも未発行として初期プールに残す
      const mockRpc = createRpcMock({
        issuedCounts: {},
        transactionResponses: [{ data: { is_duplicate: false, limit_reached: true }, error: null }],
      })

      mockGetSupabaseAdmin.mockReturnValue({
        from: vi.fn((table: string) => (table === 'cards' ? cardsQuery : createMockQueryBuilder())),
        rpc: mockRpc,
      } as unknown as ReturnType<typeof getSupabaseAdmin>)

      const service = new GachaService()
      const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-exhausted')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe(CARD_ISSUANCE_MESSAGES.soldOut)
      }
      // 2枚のプールを2回で使い果たして打ち切られる(発行枚数チェックRPCは別カウント)
      const transactionCalls = mockRpc.mock.calls.filter(([fnName]) => fnName === 'execute_gacha_transaction')
      expect(transactionCalls).toHaveLength(2)
    })

    it('再試行回数の上限(5回)を超えたら、プールにまだカードが残っていてもsoldOutで打ち切る', async () => {
      // 上限より多い6枚のプールを用意し、RPCが常にlimit_reachedを返す異常系でも
      // 無制限にRPCを叩き続けないことを確認する。
      const manyCards = Array.from({ length: 6 }, (_, index) => ({
        id: `card-${index}`,
        name: `Card ${index}`,
        description: null,
        image_url: null,
        rarity: 'common',
        drop_rate: 1,
        max_issuance_count: null,
      }))
      const cardsQuery = createCardsQuery(manyCards as unknown as typeof testCards)
      const mockRpc = vi.fn().mockResolvedValue({ data: { is_duplicate: false, limit_reached: true }, error: null })

      mockGetSupabaseAdmin.mockReturnValue({
        from: vi.fn((table: string) => (table === 'cards' ? cardsQuery : createMockQueryBuilder())),
        rpc: mockRpc,
      } as unknown as ReturnType<typeof getSupabaseAdmin>)

      const service = new GachaService()
      const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-retry-cap')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe(CARD_ISSUANCE_MESSAGES.soldOut)
      }
      // 6枚のプールが残っていても再試行は5回で打ち切られる(無制限ループ防止)
      expect(mockRpc).toHaveBeenCalledTimes(5)
    })
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

  // Issue #393: collection (card pack) scoping
  it('collectionName指定時は対象パックのカードだけを抽選対象にする', async () => {
    const cardsQuery = createCardsQuery(testCards)
    const mockRpc = vi.fn().mockResolvedValue({
      data: { is_duplicate: false, history_id: 'h-collection' },
      error: null,
    })

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => (table === 'cards' ? cardsQuery : createMockQueryBuilder())),
      rpc: mockRpc,
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const service = new GachaService()
    const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-1', 100, 'weapons')

    expect(result.success).toBe(true)
    expect(cardsQuery.eq).toHaveBeenCalledWith('collection_name', 'weapons')
  })

  // Issue #555: 「デフォルトパックのみ」= 未分類カード(collection_name IS NULL)
  // だけを抽選対象にする。通常のパック名指定(.eq)とは逆に .is で絞り込む必要がある。
  it('DEFAULT_PACK_SENTINEL指定時は未分類(collection_name IS NULL)のカードだけを抽選対象にする', async () => {
    const cardsQuery = createCardsQuery(testCards)
    const mockRpc = vi.fn().mockResolvedValue({
      data: { is_duplicate: false, history_id: 'h-default-pack' },
      error: null,
    })

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => (table === 'cards' ? cardsQuery : createMockQueryBuilder())),
      rpc: mockRpc,
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const service = new GachaService()
    const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-1', 100, DEFAULT_PACK_SENTINEL)

    expect(result.success).toBe(true)
    expect(cardsQuery.is).toHaveBeenCalledWith('collection_name', null)
    // A literal .eq('collection_name', '__default__') would never match any real
    // card, so the sentinel must never be passed to .eq.
    expect(cardsQuery.eq).not.toHaveBeenCalledWith('collection_name', DEFAULT_PACK_SENTINEL)
  })

  it('DEFAULT_PACK_SENTINEL指定+列未デプロイ(READ 42703)なら誤って全カード抽選せず拒否する', async () => {
    const cardsQuery = createMockQueryBuilder()
    ;(cardsQuery as unknown as Record<string, unknown>).then = (resolve: (v: unknown) => void) => {
      resolve({
        data: null,
        error: { message: 'column cards.collection_name does not exist', code: '42703' },
      })
      return cardsQuery
    }
    const mockRpc = vi.fn()

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => (table === 'cards' ? cardsQuery : createMockQueryBuilder())),
      rpc: mockRpc,
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const service = new GachaService()
    const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-1', 100, DEFAULT_PACK_SENTINEL)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('Card collections are not deployed yet')
    }
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('collection指定なしではcollection_nameで絞り込まない', async () => {
    const cardsQuery = createCardsQuery(testCards)
    const mockRpc = vi.fn().mockResolvedValue({
      data: { is_duplicate: false, history_id: 'h-all' },
      error: null,
    })

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => (table === 'cards' ? cardsQuery : createMockQueryBuilder())),
      rpc: mockRpc,
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const service = new GachaService()
    await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-1')

    const eqCalls = (cardsQuery.eq as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(eqCalls).not.toContain('collection_name')
  })

  it('collection未指定では未マイグレーション(42703)でも従来どおりDBエラーを返す(列を参照しない)', async () => {
    // collection 未指定のクエリは collection_name を一切参照しないため、
    // この機能を使わない配信者はデプロイ窓で巻き込まれない。万一別カラムの
    // 読み取りエラー(42703)が来ても collection フォールバックは発火しない。
    const cardsQuery = createMockQueryBuilder()
    ;(cardsQuery as unknown as Record<string, unknown>).then = (resolve: (v: unknown) => void) => {
      resolve({
        data: null,
        error: { message: 'column cards.some_other_column does not exist', code: '42703' },
      })
      return cardsQuery
    }
    const mockRpc = vi.fn()

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => (table === 'cards' ? cardsQuery : createMockQueryBuilder())),
      rpc: mockRpc,
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const service = new GachaService()
    const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-1')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('Database error')
    }
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('collection指定あり+列未デプロイ(READ 42703)なら誤って全カード抽選せず拒否する', async () => {
    // 実 PostgREST は SELECT/フィルタの列欠落で 42703 ("does not exist") を返す。
    // PGRST204 だけでなくこの読み取りエラー形でも検知できることを固定する(H1)。
    const cardsQuery = createMockQueryBuilder()
    ;(cardsQuery as unknown as Record<string, unknown>).then = (resolve: (v: unknown) => void) => {
      resolve({
        data: null,
        error: { message: 'column cards.collection_name does not exist', code: '42703' },
      })
      return cardsQuery
    }
    const mockRpc = vi.fn()

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => (table === 'cards' ? cardsQuery : createMockQueryBuilder())),
      rpc: mockRpc,
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const service = new GachaService()
    const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-1', 100, 'weapons')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('Card collections are not deployed yet')
    }
    expect(mockRpc).not.toHaveBeenCalled()
  })

  // Issue #579 (#576 フェーズ2): パック内レアリティ自動配分。
  // Math.randomを固定し、実効重み(effectiveWeight)から導かれる境界どおりに
  // 選択されることを決定的に検証する(統計的サンプリングは使わない)。
  describe('パック内レアリティ自動配分 (effectiveWeight)', () => {
    const packCards = [
      { id: 'c1', name: 'Common1', description: null, image_url: null, rarity: 'common', collection_name: 'weapons', drop_rate: 1.0, intra_rarity_weight: 1.0 },
      { id: 'c2', name: 'Common2', description: null, image_url: null, rarity: 'common', collection_name: 'weapons', drop_rate: 1.0, intra_rarity_weight: 1.0 },
      { id: 'r1', name: 'Rare1', description: null, image_url: null, rarity: 'rare', collection_name: 'weapons', drop_rate: 1.0, intra_rarity_weight: 1.0 },
    ]

    let randomSpy: ReturnType<typeof vi.spyOn> | null = null

    afterEach(() => {
      randomSpy?.mockRestore()
      randomSpy = null
    })

    function setupCardsAndRpc<T extends Record<string, unknown>>(cards: T[]) {
      const cardsQuery = createCardsQuery(cards)
      const mockRpc = vi.fn().mockResolvedValue({ data: { is_duplicate: false }, error: null })
      mockGetSupabaseAdmin.mockReturnValue({
        from: vi.fn((table: string) => (table === 'cards' ? cardsQuery : createMockQueryBuilder())),
        rpc: mockRpc,
      } as unknown as ReturnType<typeof getSupabaseAdmin>)
      return { cardsQuery, mockRpc }
    }

    it('自動モード: 実効重みの境界どおりにrareカードを選択する', async () => {
      // c1: 60%*(1/2)=0.3, c2: 60%*(1/2)=0.3, r1: 40%*(1/1)=0.4
      // 境界(x10000): c1=[0,3000) c2=[3000,6000) r1=[6000,10000)
      setupCardsAndRpc(packCards)
      randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.65) // -> 6500 -> r1

      const service = new GachaService()
      const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-1', 100, 'weapons', {
        rarityWeightsScope: 'global',
        rarityWeights: { common: 60, rare: 40 },
        packRarityWeights: null,
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.card.id).toBe('r1')
      }
    })

    it('自動モード: 実効重みの境界どおりにcommonカード(c2)を選択する', async () => {
      setupCardsAndRpc(packCards)
      randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.35) // -> 3500 -> c2

      const service = new GachaService()
      const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-1', 100, 'weapons', {
        rarityWeightsScope: 'global',
        rarityWeights: { common: 60, rare: 40 },
        packRarityWeights: null,
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.card.id).toBe('c2')
      }
    })

    it('選択に使ったeffectiveWeightがselectedCardのdrop_rateやAPI応答に漏れない(元のdrop_rateのまま)', async () => {
      setupCardsAndRpc(packCards)
      randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.65) // -> r1

      const service = new GachaService()
      const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-1', 100, 'weapons', {
        rarityWeightsScope: 'global',
        rarityWeights: { common: 60, rare: 40 },
        packRarityWeights: null,
      })

      expect(result.success).toBe(true)
      if (result.success) {
        // effectiveWeight(0.4)ではなく元カードのdrop_rate(1.0)がそのまま返る
        expect(result.data.card.drop_rate).toBe(1.0)
        expect(result.data.card).not.toHaveProperty('intra_rarity_weight')
      }
    })

    it('手動モード回帰: rarityWeights未設定ならdrop_rateベースの選択に戻る(effectiveWeightは無視)', async () => {
      const manualCards = [
        { id: 'c1', name: 'Common1', description: null, image_url: null, rarity: 'common', collection_name: 'weapons', drop_rate: 0.5, intra_rarity_weight: 1.0 },
        { id: 'c2', name: 'Common2', description: null, image_url: null, rarity: 'common', collection_name: 'weapons', drop_rate: 0.3, intra_rarity_weight: 1.0 },
        { id: 'r1', name: 'Rare1', description: null, image_url: null, rarity: 'rare', collection_name: 'weapons', drop_rate: 0.2, intra_rarity_weight: 1.0 },
      ]
      // drop_rate境界(x10000): c1=[0,5000) c2=[5000,8000) r1=[8000,10000)
      setupCardsAndRpc(manualCards)
      randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.85) // -> 8500 -> r1 (drop_rateベース)

      const service = new GachaService()
      const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-1', 100, 'weapons', {
        rarityWeightsScope: 'global',
        rarityWeights: null, // 手動モード
        packRarityWeights: null,
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.card.id).toBe('r1')
      }
    })

    it('無制限抽選(collectionName未指定)ではweightsConfigを無視しdrop_rateベースのまま選択する', async () => {
      const unrestrictedPool = [
        { id: 'a1', name: 'A', description: null, image_url: null, rarity: 'common', drop_rate: 0.9 },
        { id: 'a2', name: 'B', description: null, image_url: null, rarity: 'rare', drop_rate: 0.1 },
      ]
      // drop_rate境界(x10000): a1=[0,9000) a2=[9000,10000)
      // もしeffectiveWeight(common:95,rare:5→a1=[0,9500))が誤って使われるとa1が選ばれてしまう境界を選ぶ
      setupCardsAndRpc(unrestrictedPool)
      randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.92) // -> 9200

      const service = new GachaService()
      const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-1', 100, null, {
        rarityWeightsScope: 'global',
        rarityWeights: { common: 95, rare: 5 },
        packRarityWeights: null,
      })

      expect(result.success).toBe(true)
      if (result.success) {
        // drop_rateベースならa2、effectiveWeightが誤って使われればa1になる
        expect(result.data.card.id).toBe('a2')
      }
    })

    it('DEFAULT_PACK_SENTINEL + パック別重みの__default__エントリが優先される', async () => {
      const defaultPackCards = [
        { id: 'c1', name: 'Common1', description: null, image_url: null, rarity: 'common', collection_name: null, drop_rate: 1.0, intra_rarity_weight: 1.0 },
        { id: 'r1', name: 'Rare1', description: null, image_url: null, rarity: 'rare', collection_name: null, drop_rate: 1.0, intra_rarity_weight: 1.0 },
      ]
      // __default__エントリ: common 20%, rare 80% → 境界(x10000): c1=[0,2000) r1=[2000,10000)
      setupCardsAndRpc(defaultPackCards)
      randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5) // -> 5000 -> r1 (__default__エントリなら) / c1 (グローバルなら)

      const service = new GachaService()
      const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-1', 100, DEFAULT_PACK_SENTINEL, {
        rarityWeightsScope: 'per_pack',
        rarityWeights: { common: 70, rare: 30 },
        packRarityWeights: { [DEFAULT_PACK_SENTINEL]: { common: 20, rare: 80 } },
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.card.id).toBe('r1')
      }
    })

    it('per_pack継承: パック別重みにエントリが無ければグローバル重みにフォールバックする', async () => {
      // per_pack scopeだが 'weapons' にエントリが無い → グローバル(common:60,rare:40)を継承
      setupCardsAndRpc(packCards)
      randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.65) // -> 6500 -> r1 (グローバル境界どおり)

      const service = new GachaService()
      const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-1', 100, 'weapons', {
        rarityWeightsScope: 'per_pack',
        rarityWeights: { common: 60, rare: 40 },
        packRarityWeights: { characters: { common: 10, rare: 90 } }, // 'weapons'にエントリ無し
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.card.id).toBe('r1')
      }
    })
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
        raid_gacha_active_until: '2099-01-01T00:00:00.000Z',
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
        raid_gacha_active_until: '2099-01-01T00:00:00.000Z',
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

  it('追加報酬のdraw_countに応じて同一EventSubから複数カードを付与する', async () => {
    const streamerQuery = createMockQueryBuilder()
    ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        id: 'streamer-1',
        channel_point_reward_id: 'main-reward',
        chat_announcement_enabled: false,
        chat_announcement_template: null,
        raid_gacha_active_until: '2099-01-01T00:00:00.000Z',
      },
      error: null,
    })
    const additionalRewardQuery = createMockQueryBuilder()
    ;(additionalRewardQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: 'additional-1', draw_count: 3, is_raid_limited: true },
      error: null,
    })
    const cardsQuery = createCardsQuery(testCards)
    const mockRpc = vi.fn().mockResolvedValue({
      data: { is_duplicate: false },
      error: null,
    })

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'streamers') return streamerQuery
        if (table === 'streamer_additional_gacha_rewards') return additionalRewardQuery
        if (table === 'cards') return cardsQuery
        return createMockQueryBuilder()
      }),
      rpc: mockRpc,
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const service = new GachaService()
    const result = await service.executeGachaForEventSub({
      broadcaster_user_id: 'broadcaster-1',
      user_id: 'user-1',
      user_login: 'viewer',
      user_name: 'Viewer',
      reward: { id: 'raid-reward', cost: 500 },
    }, 'event-raid')

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cards).toHaveLength(3)
    }
    expect(mockRpc).toHaveBeenCalledTimes(3)
    expect(mockRpc).toHaveBeenNthCalledWith(1, 'execute_gacha_transaction', expect.objectContaining({
      p_event_id: 'event-raid',
      p_reward_cost: 500,
    }))
    expect(mockRpc).toHaveBeenNthCalledWith(2, 'execute_gacha_transaction', expect.objectContaining({
      p_event_id: 'event-raid:2',
      p_reward_cost: null,
    }))
    expect(mockRpc).toHaveBeenNthCalledWith(3, 'execute_gacha_transaction', expect.objectContaining({
      p_event_id: 'event-raid:3',
      p_reward_cost: null,
    }))
  })

  it('レイド限定の追加報酬はレイド受付期限がない通常時に発火しない', async () => {
    const streamerQuery = createMockQueryBuilder()
    ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        id: 'streamer-1',
        channel_point_reward_id: 'main-reward',
        chat_announcement_enabled: false,
        chat_announcement_template: null,
        raid_gacha_active_until: null,
      },
      error: null,
    })
    const additionalRewardQuery = createMockQueryBuilder()
    ;(additionalRewardQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: 'additional-1', draw_count: 3, is_raid_limited: true },
      error: null,
    })
    const mockRpc = vi.fn()

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'streamers') return streamerQuery
        if (table === 'streamer_additional_gacha_rewards') return additionalRewardQuery
        return createMockQueryBuilder()
      }),
      rpc: mockRpc,
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const service = new GachaService()
    const result = await service.executeGachaForEventSub({
      broadcaster_user_id: 'broadcaster-1',
      user_id: 'user-1',
      user_login: 'viewer',
      user_name: 'Viewer',
      reward: { id: 'raid-reward', cost: 500 },
    }, 'event-raid-inactive')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('Raid-limited reward inactive')
    }
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('追加報酬オプション未適用のschema cacheでは1回ガチャにフォールバックしない', async () => {
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
    const optionQuery = createMockQueryBuilder()
    ;(optionQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: null,
      error: { message: "Could not find the 'draw_count' column", code: 'PGRST204' },
    })
    const mockRpc = vi.fn().mockResolvedValue({
      data: { is_duplicate: false },
      error: null,
    })

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'streamers') return streamerQuery
        if (table === 'streamer_additional_gacha_rewards') return optionQuery
        return createMockQueryBuilder()
      }),
      rpc: mockRpc,
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const service = new GachaService()
    const result = await service.executeGachaForEventSub({
      broadcaster_user_id: 'broadcaster-1',
      user_id: 'user-1',
      user_login: 'viewer',
      user_name: 'Viewer',
      reward: { id: 'legacy-reward', cost: 100 },
    }, 'event-legacy')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('Additional reward options unavailable')
    }
    expect(mockRpc).not.toHaveBeenCalled()
  })

  // Issue #393: main reward routes its bound pack into the card query
  it('メイン報酬: channel_point_collection_nameでカードを絞り込む', async () => {
    const streamerQuery = createMockQueryBuilder()
    ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        id: 'streamer-1',
        channel_point_reward_id: 'main-reward',
        channel_point_collection_name: 'weapons',
        chat_announcement_enabled: false,
        chat_announcement_template: null,
        chat_announcement_multi_template: null,
        chat_announcement_multi_show_cards: true,
        raid_gacha_active_until: null,
      },
      error: null,
    })
    const cardsQuery = createCardsQuery(testCards)
    const mockRpc = vi.fn().mockResolvedValue({
      data: { is_duplicate: false, history_id: 'h-main-collection' },
      error: null,
    })

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'streamers') return streamerQuery
        if (table === 'cards') return cardsQuery
        return createMockQueryBuilder()
      }),
      rpc: mockRpc,
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const service = new GachaService()
    const result = await service.executeGachaForEventSub({
      broadcaster_user_id: 'broadcaster-1',
      user_id: 'user-1',
      user_login: 'viewer',
      user_name: 'Viewer',
      reward: { id: 'main-reward', cost: 100 },
    }, 'event-main-collection')

    expect(result.success).toBe(true)
    expect(cardsQuery.eq).toHaveBeenCalledWith('collection_name', 'weapons')
  })

  // Issue #579 (#576 フェーズ2): executeGachaForEventSubが取得したstreamer行の
  // rarity_weights_scope/rarity_weights/pack_rarity_weightsが、パック内自動配分の
  // 実効重み計算までちゃんと流れ込むことを、乱数固定で決定的に検証する。
  it('メイン報酬: streamerのper_packレアリティ重み設定が実効重み選択まで伝播する', async () => {
    const streamerQuery = createMockQueryBuilder()
    ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        id: 'streamer-1',
        channel_point_reward_id: 'main-reward',
        channel_point_collection_name: 'weapons',
        chat_announcement_enabled: false,
        chat_announcement_template: null,
        chat_announcement_multi_template: null,
        chat_announcement_multi_show_cards: true,
        raid_gacha_active_until: null,
        rarity_weights_scope: 'per_pack',
        rarity_weights: { common: 70, rare: 30 },
        pack_rarity_weights: { weapons: { common: 20, rare: 80 } },
      },
      error: null,
    })
    const weightedPackCards = [
      { id: 'c1', name: 'Common1', description: null, image_url: null, rarity: 'common', collection_name: 'weapons', drop_rate: 1.0, intra_rarity_weight: 1.0 },
      { id: 'r1', name: 'Rare1', description: null, image_url: null, rarity: 'rare', collection_name: 'weapons', drop_rate: 1.0, intra_rarity_weight: 1.0 },
    ]
    const cardsQuery = createCardsQuery(weightedPackCards)
    const mockRpc = vi.fn().mockResolvedValue({
      data: { is_duplicate: false, history_id: 'h-per-pack-propagation' },
      error: null,
    })

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'streamers') return streamerQuery
        if (table === 'cards') return cardsQuery
        return createMockQueryBuilder()
      }),
      rpc: mockRpc,
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    // weapons専用重み(common:20%,rare:80%) → 境界(x10000): c1=[0,2000) r1=[2000,10000)
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.9) // -> 9000 -> r1
    try {
      const service = new GachaService()
      const result = await service.executeGachaForEventSub({
        broadcaster_user_id: 'broadcaster-1',
        user_id: 'user-1',
        user_login: 'viewer',
        user_name: 'Viewer',
        reward: { id: 'main-reward', cost: 100 },
      }, 'event-per-pack-propagation')

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.card.id).toBe('r1')
      }
    } finally {
      randomSpy.mockRestore()
    }
  })

  // Issue #393: additional reward routes its own pack into the card query
  it('追加報酬: reward.collection_nameでカードを絞り込む', async () => {
    const streamerQuery = createMockQueryBuilder()
    ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        id: 'streamer-1',
        channel_point_reward_id: 'main-reward',
        channel_point_collection_name: null,
        chat_announcement_enabled: false,
        chat_announcement_template: null,
        chat_announcement_multi_template: null,
        chat_announcement_multi_show_cards: true,
        raid_gacha_active_until: null,
      },
      error: null,
    })
    const additionalRewardQuery = createMockQueryBuilder()
    ;(additionalRewardQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: 'ar-1', draw_count: 1, is_raid_limited: false, collection_name: 'characters' },
      error: null,
    })
    const cardsQuery = createCardsQuery(testCards)
    const mockRpc = vi.fn().mockResolvedValue({
      data: { is_duplicate: false, history_id: 'h-additional-collection' },
      error: null,
    })

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'streamers') return streamerQuery
        if (table === 'streamer_additional_gacha_rewards') return additionalRewardQuery
        if (table === 'cards') return cardsQuery
        return createMockQueryBuilder()
      }),
      rpc: mockRpc,
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const service = new GachaService()
    const result = await service.executeGachaForEventSub({
      broadcaster_user_id: 'broadcaster-1',
      user_id: 'user-1',
      user_login: 'viewer',
      user_name: 'Viewer',
      reward: { id: 'additional-reward', cost: 100 },
    }, 'event-additional-collection')

    expect(result.success).toBe(true)
    expect(cardsQuery.eq).toHaveBeenCalledWith('collection_name', 'characters')
  })

  // Issue #393 (production review 2-B): when only channel_point_collection_name is
  // missing in the deploy window, the targeted streamer fallback must preserve
  // raid_gacha_active_until so a raid-limited reward still fires (not silently
  // skipped after consuming channel points).
  it('列未デプロイでも raid_gacha_active_until を保全し raid限定報酬が発火する', async () => {
    const streamerQuery = createMockQueryBuilder()
    ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>)
      // primary select: channel_point_collection_name 列欠落 (READ 42703)
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: '42703',
          message: 'column streamers.channel_point_collection_name does not exist',
        },
      })
      // targeted collection fallback: raid_gacha_active_until を含む完全な行
      .mockResolvedValueOnce({
        data: {
          id: 'streamer-1',
          channel_point_reward_id: 'main-reward',
          chat_announcement_enabled: false,
          chat_announcement_template: null,
          chat_announcement_multi_template: null,
          chat_announcement_multi_show_cards: true,
          raid_gacha_active_until: '2099-01-01T00:00:00.000Z',
        },
        error: null,
      })
    const additionalRewardQuery = createMockQueryBuilder()
    ;(additionalRewardQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: 'ar-1', draw_count: 1, is_raid_limited: true, collection_name: null },
      error: null,
    })
    const cardsQuery = createCardsQuery(testCards)
    const mockRpc = vi.fn().mockResolvedValue({
      data: { is_duplicate: false, history_id: 'h-raid-deploywindow' },
      error: null,
    })

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'streamers') return streamerQuery
        if (table === 'streamer_additional_gacha_rewards') return additionalRewardQuery
        if (table === 'cards') return cardsQuery
        return createMockQueryBuilder()
      }),
      rpc: mockRpc,
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const service = new GachaService()
    const result = await service.executeGachaForEventSub({
      broadcaster_user_id: 'broadcaster-1',
      user_id: 'user-1',
      user_login: 'viewer',
      user_name: 'Viewer',
      reward: { id: 'raid-reward', cost: 500 },
    }, 'event-raid-deploywindow')

    // raid_gacha_active_until が保全されているため raid限定報酬が発火する
    expect(result.success).toBe(true)
    expect(mockRpc).toHaveBeenCalled()
  })
})

describe('GachaService.executeGachaForRaidEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('incoming raid の送信者に設定回数分のガチャを付与する', async () => {
    const streamerQuery = createMockQueryBuilder()
    ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        id: 'streamer-1',
        chat_announcement_enabled: false,
        chat_announcement_template: null,
        raid_gacha_draw_count: 2,
      },
      error: null,
    })
    const cardsQuery = createCardsQuery(testCards)
    const mockRpc = vi.fn().mockResolvedValue({
      data: { is_duplicate: false },
      error: null,
    })

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'streamers') return streamerQuery
        if (table === 'cards') return cardsQuery
        return createMockQueryBuilder()
      }),
      rpc: mockRpc,
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const service = new GachaService()
    const result = await service.executeGachaForRaidEvent({
      to_broadcaster_user_id: 'broadcaster-1',
      from_broadcaster_user_id: 'raider-1',
      from_broadcaster_user_login: 'raider',
      from_broadcaster_user_name: 'Raider',
    }, 'raid-event-1')

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cards).toHaveLength(2)
      expect(result.data.userTwitchUsername).toBe('Raider')
      expect(result.data.streamer?.id).toBe('streamer-1')
    }
    expect(streamerQuery.eq).toHaveBeenCalledWith('twitch_user_id', 'broadcaster-1')
    expect(mockRpc).toHaveBeenNthCalledWith(1, 'execute_gacha_transaction', expect.objectContaining({
      p_event_id: 'raid-event-1',
      p_user_twitch_id: 'raider-1',
      p_reward_cost: null,
    }))
    expect(mockRpc).toHaveBeenNthCalledWith(2, 'execute_gacha_transaction', expect.objectContaining({
      p_event_id: 'raid-event-1:2',
      p_user_twitch_id: 'raider-1',
      p_reward_cost: null,
    }))
  })

  it('レイド送信者プレゼントが0回ならガチャを実行しない', async () => {
    const streamerQuery = createMockQueryBuilder()
    ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        id: 'streamer-1',
        chat_announcement_enabled: false,
        chat_announcement_template: null,
        raid_gacha_draw_count: 0,
      },
      error: null,
    })
    const mockRpc = vi.fn()

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'streamers') return streamerQuery
        return createMockQueryBuilder()
      }),
      rpc: mockRpc,
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const service = new GachaService()
    const result = await service.executeGachaForRaidEvent({
      to_broadcaster_user_id: 'broadcaster-1',
      from_broadcaster_user_id: 'raider-1',
      from_broadcaster_user_name: 'Raider',
    }, 'raid-event-disabled')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('Raid gacha disabled')
    }
    expect(mockRpc).not.toHaveBeenCalled()
  })
})
