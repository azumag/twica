/**
 * #573: ガチャ経路 RPC (execute_gacha_transaction / get_issued_card_counts) の
 * postgrest / pg 直結ドライバ切替パリティテスト
 *
 * ガチャはチャネルポイント消費を伴う課金系・EventSub 高頻度のクリティカルパスで
 * あるため、以下を固定する:
 *   1. フラグ未設定時(既定 'postgrest')は getDb が一切呼ばれず既存挙動が不変
 *   2. GACHA_DB_DRIVER=pg で RPC 2箇所だけが pg 直結になり、外部挙動
 *      (ok / Duplicate event / limit_reached 再抽選 / soldOut / 42883 legacy
 *      フォールバック)が postgrest 経路と一致する
 *   3. 冪等リトライ条件: eventId 非 null (ON CONFLICT (event_id) による冪等化)
 *      のみ接続断リトライを許可、demo ガチャ(eventId=null)はリトライ禁止
 *   4. GACHA_DB_DRIVER=postgrest が DB_DRIVER=pg より優先される(緊急ロールバック)
 *
 * モックの流儀は tests/unit/gacha-service.test.ts (supabase) と
 * tests/unit/announcements-driver-parity.test.ts (getDb 上書き + vi.stubEnv) を踏襲。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { GachaService } from '@/lib/services/gacha'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getDb } from '@/lib/db/client'
import { createMockQueryBuilder } from '../utils/supabase-mock'
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

const testCards = [
  { id: 'card-1', name: 'Test Card', description: 'desc', image_url: null, rarity: 'common', drop_rate: 1.0, max_issuance_count: null },
]

/** 発行上限付きカードを含む2枚構成(get_issued_card_counts 分岐の検証用) */
const limitedTestCards = [
  { id: 'sold-out-card', name: 'Sold Out', description: null, image_url: null, rarity: 'legendary', drop_rate: 100, max_issuance_count: 1 },
  { id: 'available-card', name: 'Available', description: null, image_url: null, rarity: 'common', drop_rate: 1, max_issuance_count: null },
]

// 各テストが setupSupabase に渡した抽選プールを、同じテスト内の PG 読み取り
// mock でも共有する。これにより driver 切替前後で入力カードだけは完全に一致する。
let currentTestCards: Array<Record<string, unknown>> = testCards

/** cards クエリの thenable モック(gacha-service.test.ts と同じ流儀) */
function createCardsQuery<T extends Record<string, unknown>>(cards: T[]) {
  const q = createMockQueryBuilder()
  ;(q as unknown as Record<string, unknown>).then = (resolve: (v: unknown) => void) => {
    resolve({ data: cards, error: null })
    return q
  }
  return q
}

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
) {
  const sqlMock = createSqlMock(responses)
  // #718 で PG 経路は RPC 書き込みだけでなく、抽選プールの cards 読み取りも
  // Drizzle に統一された。where() の Promise だけで実装の await 形状を再現し、
  // SQL タグ用 responses の消費順序を変えず既存 RPC アサーションを保つ。
  const where = vi.fn().mockResolvedValue(cards)
  const from = vi.fn().mockReturnValue({ where })
  const select = vi.fn().mockReturnValue({ from })
  vi.mocked(getDb).mockResolvedValue({ db: { select } as never, sql: sqlMock as never })
  return sqlMock
}

/**
 * supabase-js クライアントモック。cards 読み取りは #573 の対象外(常に postgrest)
 * なので、pg 経路のテストでも必ず必要になる。
 */
function setupSupabase(options?: {
  cards?: Array<Record<string, unknown>>
  rpc?: ReturnType<typeof vi.fn>
  tables?: Record<string, unknown>
}) {
  currentTestCards = options?.cards ?? testCards
  const cardsQuery = createCardsQuery(currentTestCards)
  const rpc = options?.rpc ?? vi.fn()
  const fromMock = vi.fn((table: string) => {
    if (table === 'cards') return cardsQuery
    if (options?.tables && table in options.tables) return options.tables[table]
    return createMockQueryBuilder()
  })
  mockGetSupabaseAdmin.mockReturnValue({
    from: fromMock,
    rpc,
  } as unknown as ReturnType<typeof getSupabaseAdmin>)
  return { cardsQuery, fromMock, rpc }
}

describe('ガチャ RPC ドライバパリティ (#573)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    currentTestCards = testCards
  })

  // 環境変数は vi.stubEnv + vi.unstubAllEnvs で確実に復元する
  // (announcements-driver-parity.test.ts と同じ理由: 直接 mutation は他テストへ漏れる)
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('postgrest 経路(フラグ未設定): 挙動完全不変', () => {
    it('execute_gacha_transaction は既存 supabase-js RPC で実行され getDb は呼ばれない', async () => {
      const rpc = vi.fn().mockResolvedValue({
        data: { is_duplicate: false, history_id: 'h-1' },
        error: null,
      })
      setupSupabase({ rpc })

      const service = new GachaService()
      const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-1')

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.card.id).toBe('card-1')
      }
      // 既存経路の呼び出し形状(名前付きパラメータのオブジェクト)が不変であること
      expect(rpc).toHaveBeenCalledWith('execute_gacha_transaction', {
        p_event_id: 'event-1',
        p_user_twitch_id: 'user-1',
        p_user_twitch_username: 'testuser',
        p_card_id: 'card-1',
        p_streamer_id: 'streamer-1',
        p_reward_cost: null,
        p_reward_id: null,
      })
      expect(getDb).not.toHaveBeenCalled()
    })

    it('get_issued_card_counts も既存 supabase-js RPC のまま実行され getDb は呼ばれない', async () => {
      const rpc = vi.fn((fnName: string) => {
        if (fnName === 'get_issued_card_counts') {
          return Promise.resolve({ data: { 'sold-out-card': 1 }, error: null })
        }
        return Promise.resolve({ data: { is_duplicate: false, history_id: 'h-1' }, error: null })
      })
      setupSupabase({ cards: limitedTestCards, rpc })

      const service = new GachaService()
      const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-limited')

      expect(result.success).toBe(true)
      expect(rpc).toHaveBeenCalledWith('get_issued_card_counts', { p_card_ids: ['sold-out-card'] })
      expect(getDb).not.toHaveBeenCalled()
    })
  })

  describe('pg 経路 (GACHA_DB_DRIVER=pg)', () => {
    beforeEach(() => {
      // DB_DRIVER 未設定のまま GACHA_DB_DRIVER=pg だけでガチャ経路が切り替わる
      // (ガチャ個別の先行切替レバー)ことも同時に検証される
      vi.stubEnv('GACHA_DB_DRIVER', 'pg')
    })

    it('正常系: 名前付き引数の SQL が実行され ok(card) が返る(supabase rpc は不呼出)', async () => {
      const { rpc } = setupSupabase()
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

      // 書き込み RPC が postgrest 経路へ流れていないこと
      expect(rpc).not.toHaveBeenCalled()
    })

    it('rewardCost / rewardId は bind 値としてそのまま渡される', async () => {
      setupSupabase()
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

    it('冪等再送(同一 event_id の2回目 → is_duplicate): 外部挙動が postgrest 経路と一致する', async () => {
      // EventSub 再送の2回目は、どちらのドライバでも DB 側の ON CONFLICT (event_id)
      // により is_duplicate:true が返る。その後の外部挙動(err('Duplicate event'))が
      // 両経路で完全一致することを deepEqual で固定する。
      setupSupabase()
      setupPgSql([{ rows: [{ result: { is_duplicate: true } }] }])
      const pgResult = await new GachaService().executeGacha('streamer-1', 'user-1', 'testuser', 'event-dup')

      vi.unstubAllEnvs()
      const rpc = vi.fn().mockResolvedValue({ data: { is_duplicate: true }, error: null })
      setupSupabase({ rpc })
      const postgrestResult = await new GachaService().executeGacha('streamer-1', 'user-1', 'testuser', 'event-dup')

      expect(pgResult).toEqual(postgrestResult)
      expect(pgResult.success).toBe(false)
      if (!pgResult.success) {
        expect(pgResult.error).toBe('Duplicate event')
      }
    })

    it('limit_reached: 選ばれたカードを除外し、同一 eventId のまま別カードで再抽選して成功する', async () => {
      setupSupabase({
        cards: [
          { id: 'card-a', name: 'A', description: null, image_url: null, rarity: 'common', drop_rate: 0.5, max_issuance_count: null },
          { id: 'card-b', name: 'B', description: null, image_url: null, rarity: 'common', drop_rate: 0.5, max_issuance_count: null },
        ],
      })
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
      setupSupabase({
        cards: [
          { id: 'card-a', name: 'A', description: null, image_url: null, rarity: 'common', drop_rate: 0.5, max_issuance_count: null },
          { id: 'card-b', name: 'B', description: null, image_url: null, rarity: 'common', drop_rate: 0.5, max_issuance_count: null },
        ],
      })
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

    it('42883 (RPC 未デプロイ): executeGachaLegacy(postgrest 実装)へフォールバックする', async () => {
      // legacy パスの supabase 書き込みモック(gacha-service.test.ts の 42883 テストと同構成)
      const legacyUserQuery = createMockQueryBuilder()
      ;(legacyUserQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { id: 'user-1-uuid' }, error: null,
      })
      const insertQuery = createMockQueryBuilder()
      ;(insertQuery as unknown as Record<string, unknown>).then = (resolve: (v: unknown) => void) => {
        resolve({ data: null, error: null })
        return insertQuery
      }
      const upsertQuery = createMockQueryBuilder()
      ;(upsertQuery as unknown as Record<string, unknown>).then = (resolve: (v: unknown) => void) => {
        resolve({ data: null, error: null })
        return upsertQuery
      }
      const { fromMock, rpc } = setupSupabase({
        tables: {
          gacha_history: upsertQuery,
          users: legacyUserQuery,
          user_cards: insertQuery,
        },
      })
      const sqlMock = setupPgSql([
        { reject: pgError('42883', 'function execute_gacha_transaction(p_event_id => text) does not exist') },
      ])

      const service = new GachaService()
      const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-fallback')

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.card.id).toBe('card-1')
      }
      // pg RPC は1回だけ試行され、リトライされない(42883 は恒久エラー)
      expect(sqlMock).toHaveBeenCalledTimes(1)
      // legacy パス(supabase-js 実装のまま)の書き込みが実行されている
      expect(fromMock).toHaveBeenCalledWith('gacha_history')
      expect(fromMock).toHaveBeenCalledWith('users')
      // postgrest の rpc へは流れない(legacy パスは rpc を使わない)
      expect(rpc).not.toHaveBeenCalled()
    })

    it('42883 以外の pg エラー: reportError を呼び postgrest 経路と同じ形のエラーを返す', async () => {
      const { reportError } = await import('@/lib/sentry/error-handler')
      setupSupabase()
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

  describe('冪等リトライ条件 (pg 経路)', () => {
    beforeEach(() => {
      vi.stubEnv('GACHA_DB_DRIVER', 'pg')
    })

    it('eventId 非 null + CONNECTION_CLOSED: リトライして成功する(ON CONFLICT による冪等化)', async () => {
      setupSupabase()
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
      setupSupabase()
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
      setupSupabase()
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

  describe('緊急ロールバック優先順位', () => {
    it('GACHA_DB_DRIVER=postgrest は DB_DRIVER=pg より優先され、ガチャだけ旧経路で実行される', async () => {
      vi.stubEnv('DB_DRIVER', 'pg')
      vi.stubEnv('GACHA_DB_DRIVER', 'postgrest')
      const rpc = vi.fn().mockResolvedValue({
        data: { is_duplicate: false, history_id: 'h-rollback' },
        error: null,
      })
      setupSupabase({ rpc })
      const sqlMock = setupPgSql([{ rows: [] }])

      const service = new GachaService()
      const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-rollback')

      expect(result.success).toBe(true)
      expect(rpc).toHaveBeenCalledWith('execute_gacha_transaction', expect.anything())
      expect(sqlMock).not.toHaveBeenCalled()
      expect(getDb).not.toHaveBeenCalled()
    })
  })

  describe('get_issued_card_counts の pg 分岐', () => {
    beforeEach(() => {
      vi.stubEnv('GACHA_DB_DRIVER', 'pg')
    })

    it('pg で集計を取得し、上限到達カードが抽選から除外される(supabase rpc 不呼出)', async () => {
      const { rpc } = setupSupabase({ cards: limitedTestCards })
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

      expect(rpc).not.toHaveBeenCalled()
    })

    it('pg で 42883 (未デプロイ): 既存 postgrest 実装へフォールスルーして集計を取得する', async () => {
      const rpc = vi.fn((fnName: string) => {
        if (fnName === 'get_issued_card_counts') {
          return Promise.resolve({ data: { 'sold-out-card': 1 }, error: null })
        }
        // execute_gacha_transaction は pg 経路のままなのでここへは来ない想定
        return Promise.resolve({ data: null, error: { message: 'unexpected postgrest rpc', code: 'XXXXX' } })
      })
      setupSupabase({ cards: limitedTestCards, rpc })
      const sqlMock = setupPgSql([
        { reject: pgError('42883', 'function get_issued_card_counts(p_card_ids => uuid[]) does not exist') },
        { rows: [{ result: { is_duplicate: false, history_id: 'h-pg-fallthrough' } }] },
      ])

      const service = new GachaService()
      const result = await service.executeGacha('streamer-1', 'user-1', 'testuser', 'event-fallthrough')

      expect(result.success).toBe(true)
      // 集計はフォールスルー先の postgrest RPC が実行される
      expect(rpc).toHaveBeenCalledWith('get_issued_card_counts', { p_card_ids: ['sold-out-card'] })
      expect(rpc).not.toHaveBeenCalledWith('execute_gacha_transaction', expect.anything())
      // 抽選トランザクション本体は pg 経路のまま(sql 2回目)
      const transaction = renderSqlCall(sqlMock, 1)
      expect(transaction.text).toContain('execute_gacha_transaction')
      expect(transaction.values[3]).toBe('available-card')
    })

    it('pg で 42883 以外のエラー: postgrest 経路と同じ Database error を返す', async () => {
      setupSupabase({ cards: limitedTestCards })
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
