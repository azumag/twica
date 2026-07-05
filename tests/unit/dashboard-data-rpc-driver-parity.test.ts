/**
 * #573: dashboard-data の読み取り RPC を含む5関数
 * (getUserCards / getGachaUsersForStreamer / getGachaStats /
 *  getGachaCardOwnerStats / getUserCardsForStreamer) の
 * postgrest 経路 / pg 直結経路 ドライバ切替パリティテスト
 *
 * tests/unit/dashboard-data-driver-parity.test.ts (#571) と
 * tests/unit/gacha-rpc-driver-parity.test.ts (#573 ガチャ経路) の形式を踏襲し、
 * 以下を固定する:
 *   1. 同一 fixture を両経路に与えて戻り値が deepEqual であること
 *   2. RPC は名前付き引数 + 明示キャスト（::uuid / ::integer / ::timestamptz）で
 *      呼ばれ、bind 値の並びが既存 .rpc() の引数と1対1対応すること
 *   3. RETURNS JSONB の値（get_user_card_counts は行配列）が PostgREST .rpc() の
 *      data と同一形状で正規化されること
 *   4. getGachaUsersForStreamer の RPC 失敗時（42883 / 実行時エラー）は
 *      pg 経路でも同じフォールバック集約が pg クエリで実行されること
 *   5. 経路の相互不可侵: フラグ未設定で getDb 不呼出 / pg 成功経路で
 *      supabase-js クエリ不呼出
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Column, Table } from 'drizzle-orm'
import {
  getUserCards,
  getUserCardsForStreamer,
  getGachaUsersForStreamer,
  getGachaStats,
  getGachaCardOwnerStats,
} from '@/lib/dashboard-data'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getDb } from '@/lib/db/client'
import {
  cards as cardsTable,
  gachaHistory as gachaHistoryTable,
} from '@/lib/db/schema'
import { logger } from '@/lib/logger'
import { reportError } from '@/lib/sentry/error-handler'

// logger は Supabase errors パイプラインへ fire-and-forget するため副作用のない
// モックに差し替える（既存 dashboard 系テストと同じ）
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn(),
}))
// unstable_cache / react cache はパススルーにしてキャッシュ層を素通しする
// （キャッシュ「の中身」の両経路パリティを検証するため）
vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
}))
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  return { ...actual, cache: (fn: unknown) => fn }
})

// ---------------------------------------------------------------------------
// 共通 fixture（両経路に同じ RPC 戻り値 / 行データを与える）
// RPC はすべて RETURNS JSONB のため、fixture は「PostgREST .rpc() の data」＝
// 「pg の rows[0].result」そのもの。数値は to_jsonb 経由で文字列化されうる
// （NUMERIC 等）ため、一部を文字列にしてパーサの Number() 正規化も検証する。
// ---------------------------------------------------------------------------

const STREAMER = {
  id: 'streamer-1',
  twitch_user_id: 'twitch-user-1',
  twitch_username: 'streamer_one',
  twitch_display_name: 'Streamer One',
  created_at: '2025-12-01T00:00:00+00:00',
  updated_at: '2025-12-01T00:00:00+00:00',
}

function makeRpcCard(overrides: Record<string, unknown> = {}) {
  return {
    id: 'card-a',
    streamer_id: 'streamer-1',
    name: 'Card A',
    description: null,
    image_url: 'https://example.com/card-a.png',
    rarity: 'common',
    rarity_order: 4,
    // to_jsonb(c.*) は DECIMAL を文字列で返すことがある → normalizeDropRate 検証
    drop_rate: '0.25',
    is_active: true,
    created_at: '2026-01-01T00:00:00+00:00',
    updated_at: '2026-01-01T00:00:00+00:00',
    ...overrides,
  }
}

/** get_user_card_counts (00031, RETURNS JSONB) の行配列 fixture */
const USER_CARD_COUNT_ROWS = [
  { count: 2, card: makeRpcCard(), streamer: STREAMER },
  { count: 1, card: makeRpcCard({ id: 'card-b', name: 'Card B', rarity: 'rare', rarity_order: 3 }), streamer: STREAMER },
]

/** get_gacha_users_for_streamer (00032/00046, RETURNS JSONB) fixture */
const GACHA_USERS_RPC_RESULT = {
  users: [
    {
      user_twitch_id: 'viewer-1',
      username: 'viewer_one',
      draw_count: 5,
      last_draw_at: '2026-03-02 00:00:00+00',
      unique_card_ids: ['card-a', 'card-b'],
    },
  ],
  total: 12,
}

/** get_gacha_drop_stats (00038/00052, RETURNS JSONB) fixture */
const DROP_STATS_RPC_RESULT = {
  total_draws: '10',
  card_stats: [
    {
      card_id: 'card-a',
      card_name: 'Card A',
      rarity: 'common',
      image_url: 'https://example.com/card-a.png',
      configured_rate: '25.5',
      actual_count: '4',
      actual_rate: '40',
      drawer_count: '2',
      drawers: [
        {
          user_twitch_id: 'viewer-1',
          username: 'viewer_one',
          draw_count: '3',
          last_drawn_at: '2026-03-02 00:00:00+00',
        },
      ],
    },
  ],
  rarity_stats: [{ rarity: 'common', count: '4', rate: '40' }],
}

/** get_channel_point_usage_stats (00036/00039, RETURNS JSONB) fixture */
const CHANNEL_POINT_RPC_RESULT = {
  total_points: '500',
  ranking: [
    {
      user_twitch_id: 'viewer-1',
      username: 'viewer_one',
      total_points: '300',
      redemption_count: 3,
      last_redeemed_at: '2026-03-02 00:00:00+00',
    },
  ],
}

/** get_card_owner_stats (00051, RETURNS JSONB) fixture */
const CARD_OWNER_STATS_RPC_RESULT = {
  card_stats: [
    {
      card_id: 'card-a',
      card_name: 'Card A',
      rarity: 'common',
      image_url: 'https://example.com/card-a.png',
      owner_count: '2',
      owners: [
        {
          user_twitch_id: 'viewer-1',
          username: 'viewer_one',
          display_name: 'Viewer One',
          owned_count: '2',
          last_obtained_at: '2026-03-02 00:00:00+00',
        },
      ],
    },
  ],
}

/** getGachaUsersForStreamer フォールバック集約用の行 fixture（両経路共通） */
const FALLBACK_HISTORY_ROWS = [
  { user_twitch_id: 'viewer-1', user_twitch_username: 'viewer_one', card_id: 'card-a', redeemed_at: '2026-03-02T00:00:00+00:00' },
  { user_twitch_id: 'viewer-2', user_twitch_username: 'viewer_two', card_id: 'card-b', redeemed_at: '2026-03-01T12:00:00+00:00' },
  // card-inactive はアクティブカード一覧に無い → uniqueCardIds から除外される
  { user_twitch_id: 'viewer-1', user_twitch_username: 'viewer_one', card_id: 'card-inactive', redeemed_at: '2026-03-01T00:00:00+00:00' },
]
const FALLBACK_ACTIVE_CARD_ROWS = [{ id: 'card-a' }, { id: 'card-b' }]

// ---------------------------------------------------------------------------
// postgrest 経路のモック: rpc は関数名ごとの結果キュー、from はテーブルごとの
// 結果キューを順に返す thenable builder（dashboard-data-driver-parity.test.ts と
// 同じ方針: フィルタ・並び替えは評価せず fixture を「クエリ結果そのもの」とする）
// ---------------------------------------------------------------------------

interface PostgrestResult {
  data: unknown
  error: unknown
  count?: number | null
}

function createSupabaseClientMock(config: {
  rpcResultsByFn?: Record<string, PostgrestResult[]>
  resultsByTable?: Record<string, PostgrestResult[]>
} = {}) {
  const rpcQueues = Object.fromEntries(
    Object.entries(config.rpcResultsByFn ?? {}).map(([fn, results]) => [fn, [...results]])
  )
  const tableQueues = Object.fromEntries(
    Object.entries(config.resultsByTable ?? {}).map(([table, results]) => [table, [...results]])
  )

  const rpc = vi.fn((fnName: string) => {
    const queue = rpcQueues[fnName]
    if (!queue || queue.length === 0) {
      throw new Error(`no mock rpc result configured for: ${fnName}`)
    }
    // 同一 RPC の複数呼び出し（リトライ等）は先頭から消費し、最後の1件は残す
    const result = queue.length > 1 ? (queue.shift() as PostgrestResult) : queue[0]
    return Promise.resolve(result)
  })

  const from = vi.fn((table: string) => {
    const queue = tableQueues[table]
    if (!queue || queue.length === 0) {
      throw new Error(`no mock result configured for table: ${table}`)
    }
    const result = queue.length > 1 ? (queue.shift() as PostgrestResult) : queue[0]
    const builder: any = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      in: vi.fn(() => builder),
      gte: vi.fn(() => builder),
      gt: vi.fn(() => builder),
      order: vi.fn(() => builder),
      range: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      maybeSingle: vi.fn(() => Promise.resolve(result)),
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve(result).then(onFulfilled, onRejected),
    }
    return builder
  })

  return { from, rpc }
}

// ---------------------------------------------------------------------------
// pg 経路のモック
// - sql: postgres.js のタグ呼び出しを模し、応答キューを順に消費する
//   （gacha-rpc-driver-parity.test.ts の createSqlMock と同じ流儀）
// - db: getGachaUsersForStreamer の pg フォールバックが使う Drizzle の
//   「列指定 select（JOIN なし）」だけを最小限エミュレートする
// ---------------------------------------------------------------------------

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

function createDrizzleDbMock(rowsByTable: Map<Table, Array<Record<string, unknown>>> = new Map()) {
  const db = {
    select: vi.fn((fields: Record<string, unknown>) => ({
      from: vi.fn((table: Table) => {
        const evaluate = () => {
          const rows = rowsByTable.get(table) ?? []
          // 列指定 select の射影のみ（実装のフォールバッククエリは JOIN を使わない）
          return rows.map((row) =>
            Object.fromEntries(
              Object.entries(fields).map(([key, field]) => [
                key,
                row[(field as Column).name] ?? null,
              ])
            )
          )
        }
        const builder: any = {
          where: vi.fn(() => builder),
          orderBy: vi.fn(() => builder),
          limit: vi.fn(() => builder),
          then: (onFulfilled: any, onRejected: any) =>
            Promise.resolve().then(evaluate).then(onFulfilled, onRejected),
        }
        return builder
      }),
    })),
  }
  return db
}

// ---------------------------------------------------------------------------
// 実行ヘルパー
// 環境変数は vi.stubEnv + afterEach unstubAllEnvs（既存 parity テストと同じ理由:
// process.env 直接変更はテスト失敗時に他テストへ漏れる）
// ---------------------------------------------------------------------------

type SupabaseMockConfig = Parameters<typeof createSupabaseClientMock>[0]

async function runPostgrest<T>(config: SupabaseMockConfig, run: () => Promise<T>) {
  vi.stubEnv('DB_DRIVER', undefined)
  const client = createSupabaseClientMock(config)
  vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
  const result = await run()
  return { result, client }
}

async function runPg<T>(
  config: {
    sqlResponses: Array<{ rows?: unknown[]; reject?: unknown }>
    tables?: Map<Table, Array<Record<string, unknown>>>
    /** 42883 フォールスルー先（postgrest 直接クエリ）を検証するテスト用 */
    supabase?: SupabaseMockConfig
  },
  run: () => Promise<T>
) {
  vi.stubEnv('DB_DRIVER', 'pg-read')
  const client = createSupabaseClientMock(config.supabase ?? {})
  vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
  const sqlMock = createSqlMock(config.sqlResponses)
  const db = createDrizzleDbMock(config.tables)
  vi.mocked(getDb).mockResolvedValue({ db, sql: sqlMock } as any)
  const result = await run()
  return { result, client, sqlMock, db }
}

// ---------------------------------------------------------------------------
// テスト本体
// ---------------------------------------------------------------------------

describe('dashboard-data: 読み取り RPC の postgrest / pg 経路パリティ (#573)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('getUserCards (get_user_card_counts)', () => {
    it('RPC 成功: 行配列がそのまま得られ、両経路の戻り値が deepEqual になる', async () => {
      const { result: postgrestResult } = await runPostgrest(
        { rpcResultsByFn: { get_user_card_counts: [{ data: USER_CARD_COUNT_ROWS, error: null }] } },
        () => getUserCards('viewer-1')
      )
      const { result: pgResult, sqlMock, client } = await runPg(
        { sqlResponses: [{ rows: [{ result: USER_CARD_COUNT_ROWS }] }] },
        () => getUserCards('viewer-1')
      )

      expect(pgResult).toEqual(postgrestResult)
      // 行配列（JSONB 配列）が両経路とも同じ CardWithDetails[] にパースされる
      // （drop_rate は to_jsonb の文字列から数値へ正規化される）
      expect(pgResult).toEqual([
        { ...makeRpcCard(), drop_rate: 0.25, streamer: STREAMER, count: 2 },
        {
          ...makeRpcCard({ id: 'card-b', name: 'Card B', rarity: 'rare', rarity_order: 3 }),
          drop_rate: 0.25,
          streamer: STREAMER,
          count: 1,
        },
      ])

      // 名前付き引数・bind 値の並びを固定（既存 .rpc() と同一の引数リスト:
      // p_twitch_user_id のみで p_streamer_id は送らない）
      expect(sqlMock).toHaveBeenCalledTimes(1)
      const { text, values } = renderSqlCall(sqlMock, 0)
      expect(text).toContain('get_user_card_counts')
      expect(text).toContain('p_twitch_user_id => $')
      expect(text).not.toContain('p_streamer_id')
      expect(values).toEqual(['viewer-1'])

      // pg 成功経路では supabase-js クエリへ一切流れない
      expect(client.rpc).not.toHaveBeenCalled()
      expect(client.from).not.toHaveBeenCalled()
    })

    it('pg で 42883 (RPC 未デプロイ): 既存 postgrest 直接クエリフォールバックへフォールスルーする', async () => {
      const userCardRows = [
        { card_id: 'card-a', cards: { ...makeRpcCard(), streamers: STREAMER } },
        { card_id: 'card-a', cards: { ...makeRpcCard(), streamers: STREAMER } },
      ]
      // 両経路とも「RPC 42883 → users / user_cards の直接クエリ集計」に落ちる
      const { result: postgrestResult } = await runPostgrest(
        {
          rpcResultsByFn: {
            get_user_card_counts: [
              { data: null, error: { code: '42883', message: 'function get_user_card_counts does not exist' } },
            ],
          },
          resultsByTable: {
            users: [{ data: { id: 'user-uuid-1' }, error: null }],
            user_cards: [{ data: userCardRows, error: null }],
          },
        },
        () => getUserCards('viewer-1')
      )
      const { result: pgResult, client } = await runPg(
        {
          sqlResponses: [
            { reject: pgError('42883', 'function get_user_card_counts(p_twitch_user_id => text) does not exist') },
          ],
          supabase: {
            resultsByTable: {
              users: [{ data: { id: 'user-uuid-1' }, error: null }],
              user_cards: [{ data: userCardRows, error: null }],
            },
          },
        },
        () => getUserCards('viewer-1')
      )

      expect(pgResult).toEqual(postgrestResult)
      expect(pgResult).toHaveLength(1)
      expect(pgResult[0]).toMatchObject({ id: 'card-a', count: 2 })
      // フォールスルー先は本番実績のある postgrest 直接クエリ
      expect(client.from).toHaveBeenCalledWith('users')
      expect(client.from).toHaveBeenCalledWith('user_cards')
      // 42883 はデプロイ窓の正常系: warn のみで reportError しない（既存挙動）
      expect(vi.mocked(reportError)).not.toHaveBeenCalled()
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'get_user_card_counts not deployed, falling back to direct query'
      )
    })

    it('pg で接続断 (CONNECTION_CLOSED): 読み取りは冪等としてリトライされ成功する', async () => {
      const { result, sqlMock } = await runPg(
        {
          sqlResponses: [
            { reject: pgError('CONNECTION_CLOSED', 'write CONNECTION_CLOSED') },
            { rows: [{ result: USER_CARD_COUNT_ROWS }] },
          ],
        },
        () => getUserCards('viewer-1')
      )

      expect(sqlMock).toHaveBeenCalledTimes(2)
      expect(result).toHaveLength(2)
      expect(vi.mocked(reportError)).not.toHaveBeenCalled()
    })
  })

  describe('getUserCardsForStreamer (get_user_card_counts + p_streamer_id)', () => {
    it('RPC 成功: p_streamer_id は ::uuid 明示キャストで渡され、両経路の戻り値が deepEqual になる', async () => {
      const { result: postgrestResult, client: postgrestClient } = await runPostgrest(
        { rpcResultsByFn: { get_user_card_counts: [{ data: USER_CARD_COUNT_ROWS, error: null }] } },
        () => getUserCardsForStreamer('viewer-1', 'streamer-1')
      )
      const { result: pgResult, sqlMock, client } = await runPg(
        { sqlResponses: [{ rows: [{ result: USER_CARD_COUNT_ROWS }] }] },
        () => getUserCardsForStreamer('viewer-1', 'streamer-1')
      )

      // 既存経路の呼び出し形状（名前付きパラメータのオブジェクト）が不変であること
      expect(postgrestClient.rpc).toHaveBeenCalledWith('get_user_card_counts', {
        p_twitch_user_id: 'viewer-1',
        p_streamer_id: 'streamer-1',
      })

      expect(pgResult).toEqual(postgrestResult)
      const { text, values } = renderSqlCall(sqlMock, 0)
      expect(text).toContain('get_user_card_counts')
      expect(text).toContain('p_twitch_user_id => $')
      expect(text).toContain('p_streamer_id => $::uuid')
      expect(values).toEqual(['viewer-1', 'streamer-1'])
      expect(client.rpc).not.toHaveBeenCalled()
    })
  })

  describe('getGachaUsersForStreamer (get_gacha_users_for_streamer)', () => {
    it('RPC 成功: 名前付き引数（uuid/integer 明示キャスト）で呼ばれ、両経路の戻り値が deepEqual になる', async () => {
      const { result: postgrestResult, client: postgrestClient } = await runPostgrest(
        { rpcResultsByFn: { get_gacha_users_for_streamer: [{ data: GACHA_USERS_RPC_RESULT, error: null }] } },
        () => getGachaUsersForStreamer('streamer-1', { page: 2, perPage: 20 })
      )
      const { result: pgResult, sqlMock, client } = await runPg(
        { sqlResponses: [{ rows: [{ result: GACHA_USERS_RPC_RESULT }] }] },
        () => getGachaUsersForStreamer('streamer-1', { page: 2, perPage: 20 })
      )

      expect(postgrestClient.rpc).toHaveBeenCalledWith('get_gacha_users_for_streamer', {
        p_streamer_id: 'streamer-1',
        p_limit: 20,
        p_offset: 20,
      })

      expect(pgResult).toEqual(postgrestResult)
      expect(pgResult).toEqual({
        users: [
          {
            userTwitchId: 'viewer-1',
            username: 'viewer_one',
            drawCount: 5,
            uniqueCards: 2,
            uniqueCardIds: ['card-a', 'card-b'],
            lastDrawAt: '2026-03-02 00:00:00+00',
          },
        ],
        pagination: { page: 2, perPage: 20, total: 12, totalPages: 1 },
      })

      // 名前付き引数と bind 値の並び（既存 .rpc() の p_limit/p_offset と同じ値）
      const { text, values } = renderSqlCall(sqlMock, 0)
      expect(text).toContain('get_gacha_users_for_streamer')
      expect(text).toContain('p_streamer_id => $::uuid')
      expect(text).toContain('p_limit => $::integer')
      expect(text).toContain('p_offset => $::integer')
      expect(values).toEqual(['streamer-1', 20, 20])

      expect(client.rpc).not.toHaveBeenCalled()
      expect(client.from).not.toHaveBeenCalled()
    })

    it('RPC 実行時エラー: 両経路とも reportError + フォールバック集約（pg 経路は pg クエリで再現）', async () => {
      const { result: postgrestResult, client: postgrestClient } = await runPostgrest(
        {
          rpcResultsByFn: {
            get_gacha_users_for_streamer: [
              { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } },
            ],
          },
          resultsByTable: {
            gacha_history: [{ data: FALLBACK_HISTORY_ROWS, error: null }],
            cards: [{ data: FALLBACK_ACTIVE_CARD_ROWS, error: null }],
          },
        },
        () => getGachaUsersForStreamer('streamer-1')
      )
      expect(vi.mocked(reportError)).toHaveBeenCalledTimes(1)
      vi.mocked(reportError).mockClear()

      const { result: pgResult, client } = await runPg(
        {
          sqlResponses: [{ reject: pgError('57014', 'canceling statement due to statement timeout') }],
          tables: new Map<Table, Array<Record<string, unknown>>>([
            [gachaHistoryTable, FALLBACK_HISTORY_ROWS],
            [cardsTable, FALLBACK_ACTIVE_CARD_ROWS],
          ]),
        },
        () => getGachaUsersForStreamer('streamer-1')
      )

      expect(pgResult).toEqual(postgrestResult)
      // フォールバック集約の中身（ドロー数降順・アクティブカードのみ集計）
      expect(pgResult).toEqual({
        users: [
          {
            userTwitchId: 'viewer-1',
            username: 'viewer_one',
            drawCount: 2,
            uniqueCards: 1,
            uniqueCardIds: ['card-a'],
            lastDrawAt: '2026-03-02T00:00:00+00:00',
          },
          {
            userTwitchId: 'viewer-2',
            username: 'viewer_two',
            drawCount: 1,
            uniqueCards: 1,
            uniqueCardIds: ['card-b'],
            lastDrawAt: '2026-03-01T12:00:00+00:00',
          },
        ],
        pagination: { page: 1, perPage: 20, total: 2, totalPages: 1 },
      })

      // 実行時エラーは両経路とも reportError（42883 と違い運用へ可観測化する既存挙動）
      expect(vi.mocked(reportError)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(reportError).mock.calls[0][0]).toMatchObject({
        message: expect.stringContaining('get_gacha_users_for_streamer RPC failed'),
      })
      // postgrest 経路は .from() フォールバック、pg 経路は supabase-js を一切使わない
      expect(postgrestClient.from).toHaveBeenCalledWith('gacha_history')
      expect(postgrestClient.from).toHaveBeenCalledWith('cards')
      expect(client.from).not.toHaveBeenCalled()
      expect(client.rpc).not.toHaveBeenCalled()
    })

    it('pg で 42883 (RPC 未デプロイ): warn のみで pg フォールバック集約に落ち、reportError しない', async () => {
      const { result, client } = await runPg(
        {
          sqlResponses: [
            { reject: pgError('42883', 'function get_gacha_users_for_streamer(p_streamer_id => uuid) does not exist') },
          ],
          tables: new Map<Table, Array<Record<string, unknown>>>([
            [gachaHistoryTable, FALLBACK_HISTORY_ROWS],
            [cardsTable, FALLBACK_ACTIVE_CARD_ROWS],
          ]),
        },
        () => getGachaUsersForStreamer('streamer-1')
      )

      expect(result.pagination.total).toBe(2)
      expect(result.users[0]).toMatchObject({ userTwitchId: 'viewer-1', drawCount: 2 })
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'get_gacha_users_for_streamer not deployed, falling back to client-side aggregation'
      )
      expect(vi.mocked(reportError)).not.toHaveBeenCalled()
      expect(client.from).not.toHaveBeenCalled()
    })
  })

  describe('getGachaStats (get_gacha_drop_stats + get_channel_point_usage_stats)', () => {
    it('両 RPC 成功: 名前付き引数（uuid/timestamptz/integer 明示キャスト）で呼ばれ、両経路の戻り値が deepEqual になる', async () => {
      const { result: postgrestResult, client: postgrestClient } = await runPostgrest(
        {
          rpcResultsByFn: {
            get_gacha_drop_stats: [{ data: DROP_STATS_RPC_RESULT, error: null }],
            get_channel_point_usage_stats: [{ data: CHANNEL_POINT_RPC_RESULT, error: null }],
          },
        },
        () => getGachaStats('streamer-1', '7d')
      )
      const { result: pgResult, sqlMock, client } = await runPg(
        {
          // Promise.all の配列順 = 実行開始順: 1回目 drop stats / 2回目 channel points
          sqlResponses: [
            { rows: [{ result: DROP_STATS_RPC_RESULT }] },
            { rows: [{ result: CHANNEL_POINT_RPC_RESULT }] },
          ],
        },
        () => getGachaStats('streamer-1', '7d')
      )

      // 既存経路の呼び出し形状が不変であること
      expect(postgrestClient.rpc).toHaveBeenCalledWith('get_gacha_drop_stats', {
        p_streamer_id: 'streamer-1',
        p_from_date: expect.any(String),
      })
      expect(postgrestClient.rpc).toHaveBeenCalledWith('get_channel_point_usage_stats', {
        p_streamer_id: 'streamer-1',
        p_from_date: null,
        p_limit: 10,
      })

      expect(pgResult).toEqual(postgrestResult)
      // 文字列数値は両経路とも Number() 正規化される（共有パーサ経由の検証）
      expect(pgResult.totalDraws).toBe(10)
      expect(pgResult.cardStats[0]).toMatchObject({
        cardId: 'card-a',
        configuredRate: 25.5,
        actualCount: 4,
        drawerCount: 2,
        drawers: [
          {
            userTwitchId: 'viewer-1',
            username: 'viewer_one',
            drawCount: 3,
            lastDrawnAt: '2026-03-02 00:00:00+00',
          },
        ],
      })
      expect(pgResult.channelPointStats).toEqual({
        totalPoints: 500,
        ranking: [
          {
            userTwitchId: 'viewer-1',
            username: 'viewer_one',
            totalPoints: 300,
            redemptionCount: 3,
            lastRedeemedAt: '2026-03-02 00:00:00+00',
          },
        ],
      })

      expect(sqlMock).toHaveBeenCalledTimes(2)
      const dropStatsCall = renderSqlCall(sqlMock, 0)
      expect(dropStatsCall.text).toContain('get_gacha_drop_stats')
      expect(dropStatsCall.text).toContain('p_streamer_id => $::uuid')
      expect(dropStatsCall.text).toContain('p_from_date => $::timestamptz')
      // 既存 .rpc() と同じく p_limit_per_card は送らない（DEFAULT に任せる）
      expect(dropStatsCall.text).not.toContain('p_limit_per_card')
      expect(dropStatsCall.values[0]).toBe('streamer-1')
      expect(typeof dropStatsCall.values[1]).toBe('string')

      const channelPointCall = renderSqlCall(sqlMock, 1)
      expect(channelPointCall.text).toContain('get_channel_point_usage_stats')
      expect(channelPointCall.text).toContain('p_streamer_id => $::uuid')
      expect(channelPointCall.text).toContain('p_from_date => $::timestamptz')
      expect(channelPointCall.text).toContain('p_limit => $::integer')
      // 既存 .rpc() と同じ値（p_from_date: null / p_limit: 10）が bind される
      expect(channelPointCall.values).toEqual(['streamer-1', null, 10])

      expect(client.rpc).not.toHaveBeenCalled()
      expect(client.from).not.toHaveBeenCalled()
    })
  })

  describe('getGachaCardOwnerStats (get_card_owner_stats)', () => {
    it('RPC 成功: 名前付き引数（uuid 明示キャスト）で呼ばれ、両経路の戻り値が deepEqual になる', async () => {
      const { result: postgrestResult, client: postgrestClient } = await runPostgrest(
        { rpcResultsByFn: { get_card_owner_stats: [{ data: CARD_OWNER_STATS_RPC_RESULT, error: null }] } },
        () => getGachaCardOwnerStats('streamer-1')
      )
      const { result: pgResult, sqlMock, client } = await runPg(
        { sqlResponses: [{ rows: [{ result: CARD_OWNER_STATS_RPC_RESULT }] }] },
        () => getGachaCardOwnerStats('streamer-1')
      )

      expect(postgrestClient.rpc).toHaveBeenCalledWith('get_card_owner_stats', {
        p_streamer_id: 'streamer-1',
      })

      expect(pgResult).toEqual(postgrestResult)
      expect(pgResult).toEqual({
        cardStats: [
          {
            cardId: 'card-a',
            cardName: 'Card A',
            rarity: 'common',
            imageUrl: 'https://example.com/card-a.png',
            ownerCount: 2,
            owners: [
              {
                userTwitchId: 'viewer-1',
                username: 'viewer_one',
                displayName: 'Viewer One',
                ownedCount: 2,
                lastObtainedAt: '2026-03-02 00:00:00+00',
              },
            ],
          },
        ],
      })

      const { text, values } = renderSqlCall(sqlMock, 0)
      expect(text).toContain('get_card_owner_stats')
      expect(text).toContain('p_streamer_id => $::uuid')
      // 既存 .rpc() と同じく p_limit_per_card は送らない（DEFAULT に任せる）
      expect(text).not.toContain('p_limit_per_card')
      expect(values).toEqual(['streamer-1'])

      expect(client.rpc).not.toHaveBeenCalled()
      expect(client.from).not.toHaveBeenCalled()
    })
  })

  describe('フラグ分岐の分離（経路間の相互不可侵）', () => {
    it('postgrest 経路（フラグ未設定）では getDb が一切呼ばれない', async () => {
      await runPostgrest(
        {
          rpcResultsByFn: {
            get_user_card_counts: [{ data: USER_CARD_COUNT_ROWS, error: null }],
            get_gacha_users_for_streamer: [{ data: GACHA_USERS_RPC_RESULT, error: null }],
            get_gacha_drop_stats: [{ data: DROP_STATS_RPC_RESULT, error: null }],
            get_channel_point_usage_stats: [{ data: CHANNEL_POINT_RPC_RESULT, error: null }],
            get_card_owner_stats: [{ data: CARD_OWNER_STATS_RPC_RESULT, error: null }],
          },
        },
        async () => {
          await getUserCards('viewer-1')
          await getUserCardsForStreamer('viewer-1', 'streamer-1')
          await getGachaUsersForStreamer('streamer-1')
          await getGachaStats('streamer-1', '7d')
          await getGachaCardOwnerStats('streamer-1')
        }
      )
      expect(getDb).not.toHaveBeenCalled()
    })
  })
})
