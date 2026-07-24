/**
 * #573: PlanetScale ガチャ RPC (execute_gacha_transaction /
 * get_issued_card_counts) の契約・障害時挙動テスト
 *
 * ガチャはチャネルポイント消費を伴う課金系・EventSub 高頻度のクリティカルパスで
 * あるため、以下を固定する:
 *   1. RPC の名前付き引数と戻り値マッピング
 *   2. Duplicate event / limit_reached 再抽選 / soldOut / 42883 の安全側挙動
 *   3. 冪等リトライ条件: eventId 非 null (ON CONFLICT (event_id) による冪等化)
 *      のみ接続断リトライを許可、demo ガチャ(eventId=null)はリトライ禁止
 *   4. RPC 未デプロイ時も同じ PlanetScale の集計クエリへフォールバックする
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GachaService } from '@/lib/services/gacha'
import { getDb } from '@/lib/db/client'
import { CARD_ISSUANCE_MESSAGES } from '@/lib/card-issuance'
import { reportError } from '@/lib/sentry/error-handler'

vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn(),
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}))

const testCards = [
  { id: 'card-1', name: 'Test Card', description: 'desc', image_url: null, rarity: 'common', drop_rate: 1.0, max_issuance_count: null },
]

/** 発行上限付きカードを含む2枚構成(get_issued_card_counts 分岐の検証用) */
const limitedTestCards = [
  { id: 'sold-out-card', name: 'Sold Out', description: null, image_url: null, rarity: 'legendary', drop_rate: 100, max_issuance_count: 1 },
  { id: 'available-card', name: 'Available', description: null, image_url: null, rarity: 'common', drop_rate: 1, max_issuance_count: null },
]

// 各テストの抽選プールを Drizzle 読み取りモックへ渡す。
let currentTestCards: Array<Record<string, unknown>> = testCards

/**
 * postgres.js の sql タグ呼び出し(sql`...${v}...`)を模したモック。
 * 呼び出しごとに responses を1つずつ消費し、最後の要素は使い切った後も
 * 繰り返し返す(createRpcMock と同じ「以降は同じ値」の挙動)。
 * rows は resolve、reject は Promise.reject する。
 */
function createSqlMock(responses: Array<{ rows?: unknown[]; reject?: unknown }>) {
  let callIndex = 0
  return vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    void strings
    void values
    const response = responses[Math.min(callIndex, responses.length - 1)]
    callIndex += 1
    return response.reject !== undefined
      ? Promise.reject(response.reject)
      : Promise.resolve(response.rows ?? [])
  })
}

/** postgres.js が throw するエラー(err.code に SQLSTATE/ドライバコード)を模す */
function pgError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

/**
 * sql タグ呼び出しから「バインド位置を $ で可視化した SQL テキスト」と bind 値を
 * 取り出す(実 postgres.js は $1..$n を割り当てる)。名前付き引数のマッピングと
 * 値の並び(取り違え事故防止)をテストで固定するために使う。
 */
function renderSqlCall(sqlMock: ReturnType<typeof vi.fn>, index: number) {
  const [strings, ...values] = sqlMock.mock.calls[index] as [readonly string[], ...unknown[]]
  return { text: strings.join('$'), values }
}

function setupPgSql(
  responses: Array<{ rows?: unknown[]; reject?: unknown }>,
  cards: Array<Record<string, unknown>> = currentTestCards,
  issuedCountFallbackRows: Array<Record<string, unknown>> = [],
) {
  const sqlMock = createSqlMock(responses)
  // #718 で PG 経路は RPC 書き込みだけでなく、抽選プールの cards 読み取りも
  // Drizzle に統一された。where() の Promise だけで実装の await 形状を再現し、
  // SQL タグ用 responses の消費順序を変えず既存 RPC アサーションを保つ。
  let selectIndex = 0
  const select = vi.fn(() => {
    const rows = selectIndex === 0 ? cards : issuedCountFallbackRows
    selectIndex += 1
    const builder: any = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      groupBy: vi.fn().mockResolvedValue(rows),
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve(rows).then(onFulfilled, onRejected),
    }
    return builder
  })
  vi.mocked(getDb).mockResolvedValue({ db: { select } as never, sql: sqlMock as never })
  return sqlMock
}

function setupCards(cards: Array<Record<string, unknown>> = testCards) {
  currentTestCards = cards
}

describe('ガチャ RPC ドライバパリティ (#573)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(reportError).mockResolvedValue(undefined)
    currentTestCards = testCards
  })

  describe('PlanetScale 経路', () => {

    it('正常系: 名前付き引数の SQL が実行され ok(card) が返る', async () => {
      const sqlMock = setupPgSql([
        { rows: [{ result: { is_duplicate: false, limit_reached: false, history_id: 'h-pg-1' } }] },
      ])

      const service = new GachaService()
      const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-1')

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.card.id).toBe('card-1')
        expect(result.data.userTwitchUsername).toBe('testuser')
      }
      expect(sqlMock).toHaveBeenCalledTimes(1)

      // 名前付き引数・明示キャスト・bind 値の並びを固定する(位置ズレ事故防止)
      const { text, values } = renderSqlCall(sqlMock, 0)
      expect(text).toContain('execute_gacha_transaction')
      expect(text).toContain('p_event_id => $')
      expect(text).toContain('p_user_twitch_id => $')
      expect(text).toContain('p_user_twitch_username => $')
      expect(text).toContain('p_card_id => $::uuid')
      expect(text).toContain('p_streamer_id => $::uuid')
      expect(text).toContain('p_reward_cost => $::integer')
      expect(text).toContain('p_reward_id => $')
      expect(values).toEqual(['event-1', 'user-1', 'testuser', 'card-1', 'streamer-1', null, null])

    })

    it('rewardCost / rewardId は bind 値としてそのまま渡される', async () => {
      setupCards()
      const sqlMock = setupPgSql([
        { rows: [{ result: { is_duplicate: false, history_id: 'h-pg-reward' } }] },
      ])

      const service = new GachaService()
      const result = await service.executeGacha(
        'streamer-1', 'user-1', 'testuser', 'event-reward', 500, undefined, undefined, 'reward-abc'
      )

      expect(result.success).toBe(true)
      const { values } = renderSqlCall(sqlMock, 0)
      expect(values).toEqual(['event-reward', 'user-1', 'testuser', 'card-1', 'streamer-1', 500, 'reward-abc'])
    })

    it('冪等再送(同一 event_id の2回目 → is_duplicate)は Duplicate event を返す', async () => {
      // DB 側の ON CONFLICT (event_id) が返す is_duplicate:true を、呼び出し元が
      // 再送として安全に扱える Result エラーへ変換する。
      setupCards()
      setupPgSql([{ rows: [{ result: { is_duplicate: true } }] }])
      const result = await new GachaService().executeGacha('streamer-1', 'user-1', 'testuser', 'event-dup')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe('Duplicate event')
      }
    })

    it('limit_reached: 選ばれたカードを除外し、同一 eventId のまま別カードで再抽選して成功する', async () => {
      setupCards([
          { id: 'card-a', name: 'A', description: null, image_url: null, rarity: 'common', drop_rate: 0.5, max_issuance_count: null },
          { id: 'card-b', name: 'B', description: null, image_url: null, rarity: 'common', drop_rate: 0.5, max_issuance_count: null },
      ])
      const sqlMock = setupPgSql([
        { rows: [{ result: { is_duplicate: false, limit_reached: true } }] },
        { rows: [{ result: { is_duplicate: false, limit_reached: false, history_id: 'h-pg-retry' } }] },
      ])

      const service = new GachaService()
      const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-retry')

      expect(result.success).toBe(true)
      expect(sqlMock).toHaveBeenCalledTimes(2)
      const first = renderSqlCall(sqlMock, 0)
      const second = renderSqlCall(sqlMock, 1)
      // p_card_id (values[3]) は除外が効いて別カードになる
      expect(second.values[3]).not.toBe(first.values[3])
      // p_event_id (values[0]) は両方とも同一(RPC は副作用ゼロで中断されるため安全)
      expect(first.values[0]).toBe('event-retry')
      expect(second.values[0]).toBe('event-retry')
      if (result.success) {
        expect(result.data.card.id).toBe(second.values[3])
      }
    })

    it('limit_reached が続く: プールを使い果たして soldOut を返す', async () => {
      setupCards([
          { id: 'card-a', name: 'A', description: null, image_url: null, rarity: 'common', drop_rate: 0.5, max_issuance_count: null },
          { id: 'card-b', name: 'B', description: null, image_url: null, rarity: 'common', drop_rate: 0.5, max_issuance_count: null },
      ])
      const sqlMock = setupPgSql([
        { rows: [{ result: { is_duplicate: false, limit_reached: true } }] },
      ])

      const service = new GachaService()
      const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-exhausted')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe(CARD_ISSUANCE_MESSAGES.soldOut)
      }
      expect(sqlMock).toHaveBeenCalledTimes(2)
    })

    it('42883 (必須RPC未デプロイ) は安全側で失敗する', async () => {
      const { reportError } = await import('@/lib/sentry/error-handler')
      const sqlMock = setupPgSql([
        { reject: pgError('42883', 'function execute_gacha_transaction(p_event_id => text) does not exist') },
      ])

      const service = new GachaService()
      const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-fallback')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe(
          'Failed to execute gacha transaction: function execute_gacha_transaction(p_event_id => text) does not exist',
        )
      }
      // 恒久的な schema mismatch なのでリトライせず、非原子的な旧書き込みへも落とさない。
      expect(sqlMock).toHaveBeenCalledTimes(1)
      expect(vi.mocked(reportError)).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('function execute_gacha_transaction'),
        }),
        expect.objectContaining({
          context: 'gacha:executeGacha:rpc',
          eventId: 'event-fallback',
        }),
      )
    })

    it('42883 以外のエラー: reportError を呼び Database error を返す', async () => {
      const { reportError } = await import('@/lib/sentry/error-handler')
      setupCards()
      setupPgSql([{ reject: pgError('23503', 'insert or update violates foreign key constraint') }])

      const service = new GachaService()
      const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-err')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe(
          'Failed to execute gacha transaction: insert or update violates foreign key constraint'
        )
      }
      expect(vi.mocked(reportError)).toHaveBeenCalled()
    })
  })

  describe('冪等リトライ条件', () => {

    it('eventId 非 null + CONNECTION_CLOSED: リトライして成功する(ON CONFLICT による冪等化)', async () => {
      setupCards()
      const sqlMock = setupPgSql([
        { reject: pgError('CONNECTION_CLOSED', 'write CONNECTION_CLOSED') },
        { rows: [{ result: { is_duplicate: false, history_id: 'h-pg-conn-retry' } }] },
      ])

      const service = new GachaService()
      const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-conn-retry')

      expect(result.success).toBe(true)
      expect(sqlMock).toHaveBeenCalledTimes(2)
    })

    it('接続断リトライ後の is_duplicate(初回が実はコミット済み): Duplicate event として扱う', async () => {
      // 接続断は「初回がコミットされたか不明」を意味する。リトライで is_duplicate が
      // 返るのは初回が実は成功していたケースで、カードは初回分が付与済み。
      // EventSub 再送と同じ err('Duplicate event') 扱い(呼び出し元は正常系として
      // 静かにスキップ)が正しい、という期待値を固定する。
      setupCards()
      const sqlMock = setupPgSql([
        { reject: pgError('CONNECTION_CLOSED', 'write CONNECTION_CLOSED') },
        { rows: [{ result: { is_duplicate: true } }] },
      ])

      const service = new GachaService()
      const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-ambiguous')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe('Duplicate event')
      }
      expect(sqlMock).toHaveBeenCalledTimes(2)
    })

    it('eventId null (demo ガチャ) + 接続断: 冪等キーが無いためリトライせず即エラー', async () => {
      const { reportError } = await import('@/lib/sentry/error-handler')
      setupCards()
      // 2回目の応答は成功を返す設定にしておき、「リトライされていれば成功していた」
      // 状況でも 1回で打ち切られること(=二重排出リスクの回避)を証明する
      const sqlMock = setupPgSql([
        { reject: pgError('CONNECTION_CLOSED', 'write CONNECTION_CLOSED') },
        { rows: [{ result: { is_duplicate: false, history_id: 'h-should-not-reach' } }] },
      ])

      const service = new GachaService()
      const result = await service.executeGacha('streamer-1', 'user-1', 'testuser')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe('Failed to execute gacha transaction: write CONNECTION_CLOSED')
      }
      expect(sqlMock).toHaveBeenCalledTimes(1)
      expect(vi.mocked(reportError)).toHaveBeenCalled()
    })
  })

  describe('get_issued_card_counts', () => {

    it('RPCで集計を取得し、上限到達カードが抽選から除外される', async () => {
      setupCards(limitedTestCards)
      const sqlMock = setupPgSql([
        // 1回目: get_issued_card_counts (sold-out-card は 1/1 発行済み)
        { rows: [{ result: { 'sold-out-card': 1 } }] },
        // 2回目: execute_gacha_transaction
        { rows: [{ result: { is_duplicate: false, history_id: 'h-pg-limited' } }] },
      ])

      const service = new GachaService()
      const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-limited')

      expect(result.success).toBe(true)
      expect(sqlMock).toHaveBeenCalledTimes(2)

      const counts = renderSqlCall(sqlMock, 0)
      expect(counts.text).toContain('get_issued_card_counts')
      // fetch_types:false の postgres.js では JS 配列を直接バインドできないため、
      // CSV 1値バインド + DB 側 string_to_array(...)::uuid[] 展開になっていること
      expect(counts.text).toContain("string_to_array($, ',')::uuid[]")
      expect(counts.values).toEqual(['sold-out-card'])

      // 発行上限到達カードは除外され、無制限カードで抽選される
      const transaction = renderSqlCall(sqlMock, 1)
      expect(transaction.values[3]).toBe('available-card')

    })

    it('42883 (未デプロイ): reporter障害でも同じPlanetScale上のuser_cards集計へフォールバックする', async () => {
      vi.mocked(reportError).mockRejectedValueOnce(new Error('error reporter unavailable'))
      setupCards(limitedTestCards)
      const sqlMock = setupPgSql([
        { reject: pgError('42883', 'function get_issued_card_counts(p_card_ids => uuid[]) does not exist') },
        { rows: [{ result: { is_duplicate: false, history_id: 'h-pg-fallthrough' } }] },
      ], limitedTestCards, [{ cardId: 'sold-out-card', issuedCount: 1 }])

      const service = new GachaService()
      const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-fallthrough')

      expect(result.success).toBe(true)
      // 抽選トランザクション本体は次のSQL呼び出しで続行する。
      const transaction = renderSqlCall(sqlMock, 1)
      expect(transaction.text).toContain('execute_gacha_transaction')
      expect(transaction.values[3]).toBe('available-card')
      expect(vi.mocked(reportError)).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('get_issued_card_counts RPC unavailable (SQLSTATE 42883)'),
        }),
        {
          context: 'gacha:getIssuedCounts:missingRpc',
          sqlState: '42883',
          cardCount: 1,
        },
      )
    })

    it('42883 以外のエラーは Database error を返す', async () => {
      setupCards(limitedTestCards)
      setupPgSql([{ reject: pgError('57014', 'canceling statement due to statement timeout') }])

      const service = new GachaService()
      const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-counts-err')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe('Database error: canceling statement due to statement timeout')
      }
    })
  })
})
