/**
 * #571: dashboard-data の RPC を含まない読み取り関数 10 本の
 * postgrest 経路 / pg 経路 形状互換テスト
 *
 * tests/unit/announcements-driver-parity.test.ts（#570 パイロット）の形式を踏襲し、
 * 同一 fixture を両経路のモックに与えて戻り値が deepEqual であることを検証する。
 * 特に以下を明示的にアサートする:
 *   - 埋め込み join の入れ子形状（cards は「単一オブジェクト」、
 *     streamers(twitch_display_name) は 1 列だけのネストオブジェクト）
 *   - 日付フィールドが文字列（Date オブジェクトではない）こと
 *   - 0行時の挙動（maybeSingle 相当の null / 空配列 / total 0）
 *   - 00064 デプロイ窓（collection_name 列欠落 42703）のフォールバック
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Column, SQL, Table, getTableColumns, is } from 'drizzle-orm'
import {
  getStreamerData,
  getStreamerDataPaginated,
  getRecentGachaHistory,
  getGachaHistoryForStreamer,
  getGachaHistoryForUser,
  getActiveCardsForStreamer,
  getActiveCardCountsForStreamers,
  getStreamerById,
  getUserCardDetail,
  getCollectionCompletions,
} from '@/lib/dashboard-data'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getDb } from '@/lib/db/client'
import {
  cards as cardsTable,
  collectionCompletions as collectionCompletionsTable,
  gachaHistory as gachaHistoryTable,
  streamers as streamersTable,
  userCards as userCardsTable,
  users as usersTable,
} from '@/lib/db/schema'
// Issue #685: cards の本番未デプロイ8列（card_number/hp/atk/def/spd/skill_type/
// skill_name/skill_power、#625）に対する SELECT フォールバックの検証に使う
import { CARDS_SAFE_COLUMNS } from '@/lib/db/cards-safe-columns'

/** postgres.js が投げる SQLSTATE 42703（列欠落）相当のエラー（cards-safe-columns.ts 参照） */
function missingCardsBattleColumnError(column: string = 'hp') {
  return Object.assign(new Error(`column "${column}" of relation "cards" does not exist`), {
    code: '42703',
  })
}

// logger.error は実装だと Supabase errors パイプラインへ fire-and-forget するため、
// テストでは副作用のないモックに差し替える（既存 dashboard 系テストと同じ）
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
// 共通 fixture（両経路に同じ行データを与える）
// キーは DB 列名（= PostgREST の `*` 応答 = Drizzle スキーマの列プロパティ名）。
// PostgREST の `*` は database.ts に無い実 DB 列（cards.rarity_order /
// gacha_history.reward_id 等）も返すため、fixture も全列を持つ完全な行にする。
// ---------------------------------------------------------------------------

function makeStreamerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'streamer-1',
    twitch_user_id: 'twitch-user-1',
    twitch_username: 'streamer_one',
    twitch_display_name: 'Streamer One',
    twitch_profile_image_url: null,
    channel_point_reward_id: null,
    channel_point_reward_name: null,
    channel_point_collection_name: null,
    is_active: true,
    gacha_sound_url: null,
    gacha_sound_enabled: false,
    gacha_sound_rules: [],
    chat_announcement_enabled: false,
    chat_announcement_template: null,
    chat_announcement_multi_template: null,
    chat_announcement_multi_show_cards: true,
    rarity_weights: null,
    rarity_weights_scope: 'global',
    pack_rarity_weights: null,
    custom_rarities: [],
    card_pack_names: [],
    default_card_pack_name: null,
    show_unowned_cards: false,
    show_unowned_card_details: false,
    raid_gacha_active_until: null,
    raid_gacha_draw_count: 0,
    created_at: '2025-12-01T00:00:00.000+00:00',
    updated_at: '2025-12-01T00:00:00.000+00:00',
    ...overrides,
  }
}

function makeCardRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'card-1',
    streamer_id: 'streamer-1',
    name: 'Card One',
    description: null,
    image_url: 'https://example.com/card1.png',
    rarity: 'common',
    rarity_order: 4,
    drop_rate: 0.25,
    intra_rarity_weight: 1,
    card_number: null,
    max_issuance_count: null,
    collection_name: null,
    is_active: true,
    hp: 100,
    atk: 30,
    def: 15,
    spd: 5,
    skill_type: 'attack',
    skill_name: '通常攻撃',
    skill_power: 10,
    created_at: '2026-01-01T00:00:00.000+00:00',
    updated_at: '2026-01-01T00:00:00.000+00:00',
    ...overrides,
  }
}

function makeGachaHistoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'gh-1',
    event_id: null,
    user_twitch_id: 'viewer-1',
    user_twitch_username: 'viewer_one',
    card_id: 'card-old',
    streamer_id: 'streamer-1',
    reward_cost: 100,
    reward_id: null,
    redeemed_at: '2026-02-01T00:00:00.000+00:00',
    ...overrides,
  }
}

const STREAMER = makeStreamerRow()
const CARD_OLD = makeCardRow({ id: 'card-old', created_at: '2026-01-01T00:00:00.000+00:00' })
const CARD_NEW = makeCardRow({
  id: 'card-new',
  rarity: 'rare',
  rarity_order: 3,
  created_at: '2026-01-03T00:00:00.000+00:00',
})
const HISTORY_NEW = makeGachaHistoryRow({
  id: 'gh-new',
  card_id: 'card-new',
  redeemed_at: '2026-02-02T00:00:00.000+00:00',
})
const HISTORY_OLD = makeGachaHistoryRow({
  id: 'gh-old',
  card_id: 'card-old',
  redeemed_at: '2026-02-01T00:00:00.000+00:00',
})

// ---------------------------------------------------------------------------
// postgrest 経路のモック: from(table) ごとに設定済み結果を順に返す thenable builder。
// フィルタ・並び替え・range は評価しない（fixture を「クエリ結果そのもの」として
// 与える。announcements-driver-parity.test.ts と同じ方針）。
// ---------------------------------------------------------------------------

interface PostgrestResult {
  data: unknown
  error: unknown
  count?: number | null
}

function createSupabaseClientMock(resultsByTable: Record<string, PostgrestResult[]>) {
  const queues = Object.fromEntries(
    Object.entries(resultsByTable).map(([table, results]) => [table, [...results]])
  )
  const from = vi.fn((table: string) => {
    const queue = queues[table]
    if (!queue || queue.length === 0) {
      throw new Error(`no mock result configured for table: ${table}`)
    }
    // 同一テーブルへの複数クエリ（count → rows 等）は先頭から順に消費し、
    // 最後の1件はリトライ等の再実行に備えて残す
    const result = queue.length > 1 ? (queue.shift() as PostgrestResult) : queue[0]
    const builder: any = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      in: vi.fn(() => builder),
      ilike: vi.fn(() => builder),
      gte: vi.fn(() => builder),
      lt: vi.fn(() => builder),
      order: vi.fn(() => builder),
      range: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      maybeSingle: vi.fn(() => Promise.resolve(result)),
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve(result).then(onFulfilled, onRejected),
    }
    return builder
  })
  return { from }
}

// ---------------------------------------------------------------------------
// pg 経路のモック: 実 Drizzle の挙動（選択フィールドの展開・等値結合・LEFT JOIN
// 不一致時のネスト null 化 = mapResultRow の規則）を最小限エミュレートする。
// WHERE / ORDER BY / LIMIT / OFFSET は postgrest モックと同様に評価しない。
// テーブルは実 schema オブジェクトそのものをキーにするため、実装が select する
// 列・結合するテーブルがそのまま射影結果に反映される（列の選び忘れ・結合誤りが
// 形状差としてテストで検出される）。
// ---------------------------------------------------------------------------

interface DrizzleMockConfig {
  /** テーブル（schema オブジェクト）ごとの fixture 行（キーは DB 列名） */
  tables?: Map<Table, Array<Record<string, unknown>>>
  /** count() 集計クエリが返す値（メインテーブルごと） */
  counts?: Map<Table, number>
  /** クエリ実行時に throw させるエラーのキュー（メインテーブルごと） */
  errors?: Map<Table, unknown[]>
}

function createDrizzleDbMock(config: DrizzleMockConfig = {}) {
  const db = {
    select: vi.fn((fields?: Record<string, unknown>) => ({
      from: vi.fn((mainTable: Table) => {
        const joins: Array<{ table: Table; on: SQL }> = []

        const evaluate = () => {
          const selection = fields ?? (getTableColumns(mainTable) as Record<string, unknown>)
          // 集計（count() 等）を含む選択は、実 SQL の SELECT count(*) と同じく
          // マッチ行数に関わらず常に 1 行を返す
          const hasAggregate = Object.values(selection).some((f) => is(f, SQL))

          // Issue #685 self-review fix: エラーキューは mainTable 単位だが、rows と
          // count が同一 mainTable を Promise.all で共有する関数（例:
          // getGachaHistoryForStreamerPg）では、集計クエリは実列を一切選択しない
          // ため列欠落エラー（isMissingCardsBattleColumnError 等）を構造的に
          // 受け取り得ない。集計クエリにだけエラーキューを適用しないことで、
          // rows/count どちらが先に評価されてもテストが決定的になる
          // （評価順序への依存を無くす。以前は配列リテラル評価順序 +
          // withDbRetry の実装により rows が先に消費される前提で書かれていたが、
          // その前提は実装の些細な変更で崩れうる脆弱な仮定だった）。
          if (!hasAggregate) {
            const errorQueue = config.errors?.get(mainTable)
            if (errorQueue && errorQueue.length > 0) {
              throw errorQueue.shift()
            }
          }

          // 行コンテキスト: テーブル → その行（LEFT JOIN 不一致は null）
          type Ctx = Map<Table, Record<string, unknown> | null>
          let contexts: Ctx[] = (config.tables?.get(mainTable) ?? []).map(
            (row) => new Map([[mainTable, row]]) as Ctx
          )

          // 等値結合の評価: ON 句（eq(colA, colB)）の SQL から Column を取り出す
          for (const join of joins) {
            const joinRows = config.tables?.get(join.table) ?? []
            const onColumns = join.on.queryChunks.filter((chunk): chunk is Column =>
              is(chunk, Column)
            )
            const joinCol = onColumns.find((c) => c.table === (join.table as unknown))
            const otherCol = onColumns.find((c) => c.table !== (join.table as unknown))
            if (!joinCol || !otherCol) throw new Error('unsupported join condition in mock')
            const next: Ctx[] = []
            for (const ctx of contexts) {
              const otherRow = ctx.get(otherCol.table as unknown as Table)
              const otherValue = otherRow ? otherRow[otherCol.name] : null
              const matches =
                otherValue == null
                  ? []
                  : joinRows.filter((r) => r[joinCol.name] === otherValue)
              if (matches.length > 0) {
                for (const match of matches) next.push(new Map(ctx).set(join.table, match))
              } else {
                // 対象実装の結合はすべて leftJoin（不一致は null 拡張）
                next.push(new Map(ctx).set(join.table, null))
              }
            }
            contexts = next
          }

          // 選択フィールドの射影（実 Drizzle の mapResultRow と同じ規則）:
          //  - Column → その列の値（LEFT JOIN 不一致行は null）
          //  - Table → 全列のネストオブジェクト（結合不一致は null）
          //  - ネスト選択オブジェクト → 由来テーブルの行が無ければ全体が null
          //  - SQL（count() 等の集計） → counts で設定した値
          const project = (
            sel: Record<string, unknown>,
            ctx: Ctx
          ): Record<string, unknown> =>
            Object.fromEntries(
              Object.entries(sel).map(([key, field]) => {
                if (is(field, Column)) {
                  const row = ctx.get(field.table as unknown as Table)
                  return [key, row ? (row[field.name] ?? null) : null]
                }
                if (is(field, Table)) {
                  const row = ctx.get(field)
                  if (!row) return [key, null]
                  return [key, project(getTableColumns(field) as Record<string, unknown>, ctx)]
                }
                if (is(field, SQL)) {
                  return [key, config.counts?.get(mainTable) ?? 0]
                }
                const nested = field as Record<string, Column>
                const first = Object.values(nested)[0]
                const sourceRow = first ? ctx.get(first.table as unknown as Table) : null
                return [key, sourceRow ? project(nested, ctx) : null]
              })
            )

          // 集計（count() 等）を含む選択は、実 SQL の SELECT count(*) と同じく
          // マッチ行数に関わらず常に 1 行を返す（selection/hasAggregate は
          // 関数先頭で計算済み）
          if (hasAggregate) {
            return [project(selection, new Map())]
          }
          return contexts.map((ctx) => project(selection, ctx))
        }

        const builder: any = {
          leftJoin: vi.fn((table: Table, on: SQL) => {
            joins.push({ table, on })
            return builder
          }),
          innerJoin: vi.fn((table: Table, on: SQL) => {
            joins.push({ table, on })
            return builder
          }),
          where: vi.fn(() => builder),
          orderBy: vi.fn(() => builder),
          limit: vi.fn(() => builder),
          offset: vi.fn(() => builder),
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
// 環境変数は vi.stubEnv + afterEach unstubAllEnvs（announcements テストと同じ理由:
// process.env 直接変更はテスト失敗時に他テストへ漏れる）
// ---------------------------------------------------------------------------

async function runPostgrest<T>(
  resultsByTable: Record<string, PostgrestResult[]>,
  run: () => Promise<T>
) {
  vi.stubEnv('DB_DRIVER', undefined)
  const client = createSupabaseClientMock(resultsByTable)
  vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
  const result = await run()
  return { result, client }
}

async function runPg<T>(config: DrizzleMockConfig, run: () => Promise<T>) {
  vi.stubEnv('DB_DRIVER', 'pg-read')
  const db = createDrizzleDbMock(config)
  vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any)
  const result = await run()
  return { result, db }
}

// ---------------------------------------------------------------------------
// テスト本体
// ---------------------------------------------------------------------------

describe('dashboard-data: postgrest / pg 経路の形状互換 (#571)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('getStreamerData', () => {
    it('同一 fixture で両経路の戻り値が deepEqual になる（cards は created_at 降順）', async () => {
      const { result: postgrestResult, client } = await runPostgrest(
        {
          streamers: [
            // PostgREST 埋め込み: streamer 行に cards 配列がネストされて返る
            { data: { ...STREAMER, cards: [CARD_OLD, CARD_NEW] }, error: null },
          ],
        },
        () => getStreamerData('twitch-user-1')
      )
      const { result: pgResult, db } = await runPg(
        {
          tables: new Map<Table, Array<Record<string, unknown>>>([
            [streamersTable, [STREAMER]],
            [cardsTable, [CARD_OLD, CARD_NEW]],
          ]),
        },
        () => getStreamerData('twitch-user-1')
      )

      expect(client.from).toHaveBeenCalledWith('streamers')
      expect(db.select).toHaveBeenCalledTimes(1)
      expect(pgResult).toEqual(postgrestResult)

      // JS ソート（created_at 降順）が両経路とも適用されている
      expect((pgResult as any).cards.map((c: any) => c.id)).toEqual(['card-new', 'card-old'])
      // streamer には埋め込みの cards キーが残らない（既存実装は分割代入で除去）
      expect('cards' in (pgResult as any).streamer).toBe(false)
      expect('cards' in (postgrestResult as any).streamer).toBe(false)
    })

    it('カード0枚でも両経路とも cards: [] を返す', async () => {
      const { result: postgrestResult } = await runPostgrest(
        { streamers: [{ data: { ...STREAMER, cards: [] }, error: null }] },
        () => getStreamerData('twitch-user-1')
      )
      const { result: pgResult } = await runPg(
        {
          tables: new Map<Table, Array<Record<string, unknown>>>([
            [streamersTable, [STREAMER]],
            [cardsTable, []],
          ]),
        },
        () => getStreamerData('twitch-user-1')
      )

      expect(pgResult).toEqual(postgrestResult)
      expect((pgResult as any).cards).toEqual([])
    })

    it('0行（配信者なし）では両経路とも null を返す', async () => {
      const { result: postgrestResult } = await runPostgrest(
        { streamers: [{ data: null, error: null }] },
        () => getStreamerData('missing-user')
      )
      const { result: pgResult } = await runPg(
        {
          tables: new Map<Table, Array<Record<string, unknown>>>([
            [streamersTable, []],
            [cardsTable, []],
          ]),
        },
        () => getStreamerData('missing-user')
      )

      expect(postgrestResult).toBeNull()
      expect(pgResult).toBeNull()
    })

    // Issue #685: card: cardsTable のネスト select は cards の本番未デプロイ8列
    // （card_number/hp/atk/def/spd/skill_type/skill_name/skill_power、#625）を
    // 要求するため本番で 42703 になる。列欠落エラーなら CARDS_SAFE_COLUMNS へ
    // 差し替えて再試行することを検証する（rows/count の Promise.all を伴わない
    // 単一クエリのため、エラーキューの消費順序に曖昧さがない）。
    it('本番未デプロイ8列(hp等)SELECTフォールバック: CARDS_SAFE_COLUMNSで再試行し成功する', async () => {
      const { result: pgResult, db } = await runPg(
        {
          tables: new Map<Table, Array<Record<string, unknown>>>([
            [streamersTable, [STREAMER]],
            [cardsTable, [CARD_OLD, CARD_NEW]],
          ]),
          errors: new Map([[streamersTable, [missingCardsBattleColumnError()]]]),
        },
        () => getStreamerData('twitch-user-1')
      )

      expect((pgResult as any).cards).toHaveLength(2)
      // CARDS_SAFE_COLUMNS は hp 等の8列を含まないため、フォールバック後の
      // カードにはこれらのキー自体が存在しない（production の select("*") と同じ）。
      expect((pgResult as any).cards[0]).not.toHaveProperty('hp')
      expect((pgResult as any).cards[0]).not.toHaveProperty('card_number')
      expect((pgResult as any).cards[0]).toMatchObject({ id: 'card-new', name: 'Card One' })
      // 2回目(最後)の select 呼び出しの card フィールドが CARDS_SAFE_COLUMNS であることを確認
      // select() の fields 引数は型上 optional（引数なし呼び出しも存在する）
      // だが、直前で db.select.mock.calls が最低1回は記録されていることを
      // 呼び出し自体で保証しており、かつこのテストが検証したい「最後の」
      // 呼び出しは実装上必ず fields を明示的に渡す形になっているため、
      // ここに限り non-null アサーションで受けてよい。
      const lastCall = db.select.mock.calls[db.select.mock.calls.length - 1][0]!
      expect(lastCall.card).toEqual(CARDS_SAFE_COLUMNS)
    })

    it('本番未デプロイ8列に該当しないエラーではフォールバックせず null を返す（既存挙動）', async () => {
      const { result: pgResult } = await runPg(
        {
          tables: new Map<Table, Array<Record<string, unknown>>>([
            [streamersTable, [STREAMER]],
            [cardsTable, [CARD_OLD, CARD_NEW]],
          ]),
          errors: new Map([
            [streamersTable, [Object.assign(new Error('permission denied'), { code: '42501' })]],
          ]),
        },
        () => getStreamerData('twitch-user-1')
      )

      expect(pgResult).toBeNull()
    })
  })

  describe('getStreamerDataPaginated', () => {
    it('同一 fixture で両経路の戻り値（streamer / cards / pagination）が deepEqual になる', async () => {
      const { result: postgrestResult } = await runPostgrest(
        {
          streamers: [{ data: STREAMER, error: null }],
          // 1回目: count クエリ（head: true, data なし）、2回目: ページ行
          cards: [
            { data: null, error: null, count: 3 },
            { data: [CARD_NEW, CARD_OLD], error: null },
          ],
        },
        () => getStreamerDataPaginated('twitch-user-1', 2, 2)
      )
      const { result: pgResult } = await runPg(
        {
          tables: new Map<Table, Array<Record<string, unknown>>>([
            [streamersTable, [STREAMER]],
            [cardsTable, [CARD_NEW, CARD_OLD]],
          ]),
          counts: new Map([[cardsTable, 3]]),
        },
        () => getStreamerDataPaginated('twitch-user-1', 2, 2)
      )

      expect(pgResult).toEqual(postgrestResult)
      expect((pgResult as any).pagination).toEqual({
        page: 2,
        perPage: 2,
        total: 3,
        totalPages: 2,
      })
    })

    it('0行（配信者なし）では両経路とも null を返す', async () => {
      const { result: postgrestResult } = await runPostgrest(
        { streamers: [{ data: null, error: null }] },
        () => getStreamerDataPaginated('missing-user')
      )
      const { result: pgResult } = await runPg(
        { tables: new Map<Table, Array<Record<string, unknown>>>([[streamersTable, []]]) },
        () => getStreamerDataPaginated('missing-user')
      )

      expect(postgrestResult).toBeNull()
      expect(pgResult).toBeNull()
    })

    // Issue #685: cards の無指定 select() は本番未デプロイ8列を要求する。
    // count（{ count: countRows() } のみを選択）は cards の実列を一切選択しない
    // ため、本番の postgres.js でも列欠落エラーを構造的に受け取り得ない。モック
    // 側も集計クエリをエラーキュー対象外にしている（createDrizzleDbMock の
    // hasAggregate 判定）ため、エラーは cards 側の初回試行にのみ適用され、count
    // は counts フィクスチャの本物の値をそのまま返す。cards は
    // isMissingCardsBattleColumnError 判定を通り CARDS_SAFE_COLUMNS で再試行し
    // 成功する。
    it('本番未デプロイ8列(hp等)SELECTフォールバック: cardsはCARDS_SAFE_COLUMNSで再試行し成功する', async () => {
      const { result: pgResult, db } = await runPg(
        {
          tables: new Map<Table, Array<Record<string, unknown>>>([
            [streamersTable, [STREAMER]],
            [cardsTable, [CARD_NEW, CARD_OLD]],
          ]),
          counts: new Map([[cardsTable, 2]]),
          errors: new Map([[cardsTable, [missingCardsBattleColumnError()]]]),
        },
        () => getStreamerDataPaginated('twitch-user-1', 1, 20)
      )

      // count は集計クエリのためエラーキューの影響を受けず、常に本物の total を返す
      expect((pgResult as any).pagination.total).toBe(2)
      expect((pgResult as any).cards).toHaveLength(2)
      expect((pgResult as any).cards[0]).not.toHaveProperty('hp')
      expect((pgResult as any).cards[0]).toMatchObject({ id: 'card-new' })
      // select() の fields 引数は型上 optional（引数なし呼び出しも存在する）
      // だが、直前で db.select.mock.calls が最低1回は記録されていることを
      // 呼び出し自体で保証しており、かつこのテストが検証したい「最後の」
      // 呼び出しは実装上必ず fields を明示的に渡す形になっているため、
      // ここに限り non-null アサーションで受けてよい。
      const lastCall = db.select.mock.calls[db.select.mock.calls.length - 1][0]!
      expect(lastCall).toEqual(CARDS_SAFE_COLUMNS)
    })
  })

  describe('getRecentGachaHistory', () => {
    it('埋め込み cards が「単一オブジェクト」としてネストされ、両経路で deepEqual になる', async () => {
      const { result: postgrestResult } = await runPostgrest(
        {
          gacha_history: [
            {
              data: [
                { ...HISTORY_NEW, cards: CARD_NEW },
                { ...HISTORY_OLD, cards: CARD_OLD },
              ],
              error: null,
            },
          ],
        },
        () => getRecentGachaHistory()
      )
      const { result: pgResult } = await runPg(
        {
          tables: new Map<Table, Array<Record<string, unknown>>>([
            [gachaHistoryTable, [HISTORY_NEW, HISTORY_OLD]],
            [cardsTable, [CARD_OLD, CARD_NEW]],
          ]),
        },
        () => getRecentGachaHistory()
      )

      expect(pgResult).toEqual(postgrestResult)
      expect(pgResult).toHaveLength(2)
      for (const result of [postgrestResult, pgResult]) {
        for (const entry of result as any[]) {
          // cards は多対一 FK 埋め込みなので配列ではなく単一オブジェクト
          expect(Array.isArray(entry.cards)).toBe(false)
          expect(entry.cards).toMatchObject({ id: entry.card_id })
          // 日付は文字列（Date オブジェクトではない）
          expect(typeof entry.redeemed_at).toBe('string')
          expect(entry.redeemed_at).not.toBeInstanceOf(Date)
        }
      }
    })

    // Issue #685: cards: cardsTable のネスト select は本番未デプロイ8列を要求する。
    // 単一クエリ（Promise.all を伴わない）のため、エラーキューの消費順序に
    // 曖昧さがない。
    it('本番未デプロイ8列(hp等)SELECTフォールバック: CARDS_SAFE_COLUMNSで再試行し成功する', async () => {
      const { result: pgResult, db } = await runPg(
        {
          tables: new Map<Table, Array<Record<string, unknown>>>([
            [gachaHistoryTable, [HISTORY_NEW, HISTORY_OLD]],
            [cardsTable, [CARD_OLD, CARD_NEW]],
          ]),
          errors: new Map([[gachaHistoryTable, [missingCardsBattleColumnError()]]]),
        },
        () => getRecentGachaHistory()
      )

      expect(pgResult).toHaveLength(2)
      const entry = (pgResult as any[])[0]
      expect(entry.cards).not.toHaveProperty('hp')
      expect(entry.cards).toMatchObject({ id: entry.card_id })
      // select() の fields 引数は型上 optional（引数なし呼び出しも存在する）
      // だが、直前で db.select.mock.calls が最低1回は記録されていることを
      // 呼び出し自体で保証しており、かつこのテストが検証したい「最後の」
      // 呼び出しは実装上必ず fields を明示的に渡す形になっているため、
      // ここに限り non-null アサーションで受けてよい。
      const lastCall = db.select.mock.calls[db.select.mock.calls.length - 1][0]!
      expect(lastCall.cards).toEqual(CARDS_SAFE_COLUMNS)
    })
  })

  describe('getGachaHistoryForStreamer', () => {
    it('フィルタなし: 履歴 + count のページネーション結果が両経路で deepEqual になる', async () => {
      const { result: postgrestResult } = await runPostgrest(
        {
          gacha_history: [
            {
              data: [
                { ...HISTORY_NEW, cards: CARD_NEW },
                { ...HISTORY_OLD, cards: CARD_OLD },
              ],
              error: null,
              count: 42,
            },
          ],
        },
        () => getGachaHistoryForStreamer('streamer-1', { page: 2, perPage: 20 })
      )
      const { result: pgResult, db } = await runPg(
        {
          tables: new Map<Table, Array<Record<string, unknown>>>([
            [gachaHistoryTable, [HISTORY_NEW, HISTORY_OLD]],
            [cardsTable, [CARD_OLD, CARD_NEW]],
          ]),
          counts: new Map([[gachaHistoryTable, 42]]),
        },
        () => getGachaHistoryForStreamer('streamer-1', { page: 2, perPage: 20 })
      )

      // pg 経路は rows / count の2クエリ構成（PostgREST は1リクエストで両方返す）
      expect(db.select).toHaveBeenCalledTimes(2)
      expect(pgResult).toEqual(postgrestResult)
      expect(pgResult.pagination).toEqual({
        page: 2,
        perPage: 20,
        total: 42,
        totalPages: 3,
      })
    })

    it('rarity フィルタ指定時も両経路の戻り値が deepEqual になる', async () => {
      // フィルタ自体の絞り込みはモックでは評価しない（両経路に同じ「絞り込み済み」
      // fixture を与える）。pg 経路が cards 列を参照する WHERE を組み立てても
      // クエリ構築が壊れないこと・形状が変わらないことを検証する。
      const { result: postgrestResult } = await runPostgrest(
        {
          gacha_history: [
            { data: [{ ...HISTORY_NEW, cards: CARD_NEW }], error: null, count: 1 },
          ],
        },
        () => getGachaHistoryForStreamer('streamer-1', { rarity: 'rare' })
      )
      const { result: pgResult } = await runPg(
        {
          tables: new Map<Table, Array<Record<string, unknown>>>([
            [gachaHistoryTable, [HISTORY_NEW]],
            [cardsTable, [CARD_NEW]],
          ]),
          counts: new Map([[gachaHistoryTable, 1]]),
        },
        () => getGachaHistoryForStreamer('streamer-1', { rarity: 'rare' })
      )

      expect(pgResult).toEqual(postgrestResult)
      expect(pgResult.history[0].cards.rarity).toBe('rare')
    })

    it('0行では両経路とも history: [] / total 0 / totalPages 0 を返す', async () => {
      const { result: postgrestResult } = await runPostgrest(
        { gacha_history: [{ data: [], error: null, count: 0 }] },
        () => getGachaHistoryForStreamer('streamer-1')
      )
      const { result: pgResult } = await runPg(
        {
          tables: new Map<Table, Array<Record<string, unknown>>>([
            [gachaHistoryTable, []],
            [cardsTable, []],
          ]),
          counts: new Map([[gachaHistoryTable, 0]]),
        },
        () => getGachaHistoryForStreamer('streamer-1')
      )

      expect(pgResult).toEqual(postgrestResult)
      expect(pgResult).toEqual({
        history: [],
        pagination: { page: 1, perPage: 20, total: 0, totalPages: 0 },
      })
    })

    // Issue #685: cards: cardsTable のネスト select は本番未デプロイ8列を要求する。
    // rows と count はどちらも .from(gachaHistoryTable) を使うが、count 側は
    // { count: countRows() } の集計のみで cards の列を一切選択しないため、
    // 本番の postgres.js でも列欠落エラー（isMissingCardsBattleColumnError 該当）
    // を構造的に受け取り得ない。モック側もこれに合わせて集計クエリをエラーキュー
    // の対象外にしている（createDrizzleDbMock の hasAggregate 判定、上部参照）ため、
    // rows/count が Promise.all で並行実行されても消費順序に曖昧さはなく、count は
    // 常に本物の total（42）を返す。
    it('本番未デプロイ8列(hp等)SELECTフォールバック: rowsはCARDS_SAFE_COLUMNSで再試行し成功する', async () => {
      const { result: pgResult, db } = await runPg(
        {
          tables: new Map<Table, Array<Record<string, unknown>>>([
            [gachaHistoryTable, [HISTORY_NEW, HISTORY_OLD]],
            [cardsTable, [CARD_OLD, CARD_NEW]],
          ]),
          counts: new Map([[gachaHistoryTable, 42]]),
          errors: new Map([[gachaHistoryTable, [missingCardsBattleColumnError()]]]),
        },
        () => getGachaHistoryForStreamer('streamer-1', { page: 1, perPage: 20 })
      )

      expect(pgResult.history).toHaveLength(2)
      // count は集計クエリのためエラーキューの影響を受けず、常に本物の total を返す
      expect(pgResult.pagination.total).toBe(42)
      const entry = (pgResult.history as any[])[0]
      expect(entry.cards).not.toHaveProperty('hp')
      // select() の fields 引数は型上 optional（引数なし呼び出しも存在する）
      // だが、直前で db.select.mock.calls が最低1回は記録されていることを
      // 呼び出し自体で保証しており、かつこのテストが検証したい「最後の」
      // 呼び出しは実装上必ず fields を明示的に渡す形になっているため、
      // ここに限り non-null アサーションで受けてよい。
      const lastCall = db.select.mock.calls[db.select.mock.calls.length - 1][0]!
      expect(lastCall.cards).toEqual(CARDS_SAFE_COLUMNS)
    })

    // Issue #685 self-review fix: rows/count が Promise.all で並行実行される
    // 構成で、本番未デプロイ8列に該当しないエラーが rows 側で発生した場合に
    // フォールバックせずそのまま呼び出し元の catch（history: [] 扱い）に
    // 落ちることを確認する。
    it('本番未デプロイ8列に該当しないエラーではフォールバックせず空結果を返す', async () => {
      const { result: pgResult } = await runPg(
        {
          tables: new Map<Table, Array<Record<string, unknown>>>([
            [gachaHistoryTable, [HISTORY_NEW, HISTORY_OLD]],
            [cardsTable, [CARD_OLD, CARD_NEW]],
          ]),
          counts: new Map([[gachaHistoryTable, 42]]),
          errors: new Map([
            [gachaHistoryTable, [Object.assign(new Error('permission denied'), { code: '42501' })]],
          ]),
        },
        () => getGachaHistoryForStreamer('streamer-1', { page: 1, perPage: 20 })
      )

      expect(pgResult).toEqual({
        history: [],
        pagination: { page: 1, perPage: 20, total: 0, totalPages: 0 },
      })
    })
  })

  describe('getGachaHistoryForUser', () => {
    it('cards（全列）と streamers（twitch_display_name のみ）の入れ子形状が両経路で一致する', async () => {
      const { result: postgrestResult } = await runPostgrest(
        {
          gacha_history: [
            {
              data: [
                {
                  ...HISTORY_NEW,
                  cards: CARD_NEW,
                  // 列を絞った埋め込みは、その列だけを持つ単一オブジェクトになる
                  streamers: { twitch_display_name: 'Streamer One' },
                },
              ],
              error: null,
              count: 1,
            },
          ],
        },
        () => getGachaHistoryForUser('viewer-1')
      )
      const { result: pgResult } = await runPg(
        {
          tables: new Map<Table, Array<Record<string, unknown>>>([
            [gachaHistoryTable, [HISTORY_NEW]],
            [cardsTable, [CARD_NEW]],
            [streamersTable, [STREAMER]],
          ]),
          counts: new Map([[gachaHistoryTable, 1]]),
        },
        () => getGachaHistoryForUser('viewer-1')
      )

      expect(pgResult).toEqual(postgrestResult)

      const entry = (pgResult as any).history[0]
      // streamers は twitch_display_name の 1 キーだけを持つ（全列が漏れて
      // いないこと = 列を絞った埋め込みの厳密な再現）
      expect(Object.keys(entry.streamers)).toEqual(['twitch_display_name'])
      expect(entry.streamers).toEqual({ twitch_display_name: 'Streamer One' })
      expect(Array.isArray(entry.cards)).toBe(false)
      expect(typeof entry.redeemed_at).toBe('string')
    })

    // Issue #685: getGachaHistoryForStreamer と同じ rows/count 並行実行構成
    // （どちらも .from(gachaHistoryTable)）。count は集計クエリのためエラー
    // キュー対象外（上部 createDrizzleDbMock の hasAggregate 判定参照）であり、
    // 消費順序に曖昧さはない。
    it('本番未デプロイ8列(hp等)SELECTフォールバック: rowsはCARDS_SAFE_COLUMNSで再試行し成功する', async () => {
      const { result: pgResult, db } = await runPg(
        {
          tables: new Map<Table, Array<Record<string, unknown>>>([
            [gachaHistoryTable, [HISTORY_NEW]],
            [cardsTable, [CARD_NEW]],
            [streamersTable, [STREAMER]],
          ]),
          counts: new Map([[gachaHistoryTable, 1]]),
          errors: new Map([[gachaHistoryTable, [missingCardsBattleColumnError()]]]),
        },
        () => getGachaHistoryForUser('viewer-1')
      )

      expect((pgResult as any).history).toHaveLength(1)
      expect((pgResult as any).pagination.total).toBe(1)
      const entry = (pgResult as any).history[0]
      expect(entry.cards).not.toHaveProperty('hp')
      expect(entry.streamers).toEqual({ twitch_display_name: 'Streamer One' })
      // select() の fields 引数は型上 optional（引数なし呼び出しも存在する）
      // だが、直前で db.select.mock.calls が最低1回は記録されていることを
      // 呼び出し自体で保証しており、かつこのテストが検証したい「最後の」
      // 呼び出しは実装上必ず fields を明示的に渡す形になっているため、
      // ここに限り non-null アサーションで受けてよい。
      const lastCall = db.select.mock.calls[db.select.mock.calls.length - 1][0]!
      expect(lastCall.cards).toEqual(CARDS_SAFE_COLUMNS)
    })

    // Issue #685 self-review fix: getGachaHistoryForStreamer と同様、rows/count
    // 並行実行構成での「該当しないエラーはフォールバックしない」ことの確認。
    it('本番未デプロイ8列に該当しないエラーではフォールバックせず空結果を返す', async () => {
      const { result: pgResult } = await runPg(
        {
          tables: new Map<Table, Array<Record<string, unknown>>>([
            [gachaHistoryTable, [HISTORY_NEW]],
            [cardsTable, [CARD_NEW]],
            [streamersTable, [STREAMER]],
          ]),
          counts: new Map([[gachaHistoryTable, 1]]),
          errors: new Map([
            [gachaHistoryTable, [Object.assign(new Error('permission denied'), { code: '42501' })]],
          ]),
        },
        () => getGachaHistoryForUser('viewer-1')
      )

      expect(pgResult).toEqual({
        history: [],
        pagination: { page: 1, perPage: 20, total: 0, totalPages: 0 },
      })
    })
  })

  describe('getActiveCardsForStreamer', () => {
    it('同一 fixture で両経路の戻り値が deepEqual になる（drop_rate は数値に正規化）', async () => {
      const { result: postgrestResult } = await runPostgrest(
        { cards: [{ data: [CARD_NEW, CARD_OLD], error: null }] },
        () => getActiveCardsForStreamer('streamer-1')
      )
      const { result: pgResult } = await runPg(
        { tables: new Map<Table, Array<Record<string, unknown>>>([[cardsTable, [CARD_NEW, CARD_OLD]]]) },
        () => getActiveCardsForStreamer('streamer-1')
      )

      expect(pgResult).toEqual(postgrestResult)
      expect(pgResult).toHaveLength(2)
      for (const card of pgResult as any[]) {
        expect(typeof card.drop_rate).toBe('number')
        expect(typeof card.created_at).toBe('string')
      }
    })

    // Issue #685: 無指定 select() は本番未デプロイ8列を要求する。単一クエリ
    // （Promise.all を伴わない）のため、エラーキューの消費順序に曖昧さがない。
    it('本番未デプロイ8列(hp等)SELECTフォールバック: CARDS_SAFE_COLUMNSで再試行し成功する', async () => {
      const { result: pgResult, db } = await runPg(
        {
          tables: new Map<Table, Array<Record<string, unknown>>>([[cardsTable, [CARD_NEW, CARD_OLD]]]),
          errors: new Map([[cardsTable, [missingCardsBattleColumnError()]]]),
        },
        () => getActiveCardsForStreamer('streamer-1')
      )

      expect(pgResult).toHaveLength(2)
      expect((pgResult as any[])[0]).not.toHaveProperty('hp')
      expect((pgResult as any[])[0]).not.toHaveProperty('card_number')
      // select() の fields 引数は型上 optional（引数なし呼び出しも存在する）
      // だが、直前で db.select.mock.calls が最低1回は記録されていることを
      // 呼び出し自体で保証しており、かつこのテストが検証したい「最後の」
      // 呼び出しは実装上必ず fields を明示的に渡す形になっているため、
      // ここに限り non-null アサーションで受けてよい。
      const lastCall = db.select.mock.calls[db.select.mock.calls.length - 1][0]!
      expect(lastCall).toEqual(CARDS_SAFE_COLUMNS)
    })
  })

  describe('getActiveCardCountsForStreamers', () => {
    it('複数配信者の集計 Map（totalActive / activeCardIds Set）が両経路で一致する', async () => {
      const cardOther = makeCardRow({ id: 'card-other', streamer_id: 'streamer-2' })
      const { result: postgrestResult } = await runPostgrest(
        {
          cards: [
            {
              // 既存経路の select("id, streamer_id") は 2 列だけの行を返す
              data: [
                { id: 'card-new', streamer_id: 'streamer-1' },
                { id: 'card-old', streamer_id: 'streamer-1' },
                { id: 'card-other', streamer_id: 'streamer-2' },
              ],
              error: null,
            },
          ],
        },
        // 重複と falsy はどちらの経路でも除外される
        () => getActiveCardCountsForStreamers(['streamer-1', 'streamer-2', 'streamer-1', ''])
      )
      const { result: pgResult } = await runPg(
        { tables: new Map<Table, Array<Record<string, unknown>>>([[cardsTable, [CARD_NEW, CARD_OLD, cardOther]]]) },
        () => getActiveCardCountsForStreamers(['streamer-1', 'streamer-2', 'streamer-1', ''])
      )

      expect(pgResult).toEqual(postgrestResult)
      expect(pgResult.get('streamer-1')?.totalActive).toBe(2)
      expect(pgResult.get('streamer-1')?.activeCardIds).toEqual(new Set(['card-new', 'card-old']))
      expect(pgResult.get('streamer-2')?.totalActive).toBe(1)
    })

    it('空入力では両経路ともクエリを発行せず空 Map を返す', async () => {
      const { result: postgrestResult, client } = await runPostgrest(
        {},
        () => getActiveCardCountsForStreamers([])
      )
      const { result: pgResult, db } = await runPg(
        {},
        () => getActiveCardCountsForStreamers([])
      )

      expect(postgrestResult.size).toBe(0)
      expect(pgResult.size).toBe(0)
      expect(client.from).not.toHaveBeenCalled()
      expect(db.select).not.toHaveBeenCalled()
    })
  })

  describe('getStreamerById', () => {
    it('同一 fixture で両経路の戻り値が deepEqual になる', async () => {
      const { result: postgrestResult } = await runPostgrest(
        { streamers: [{ data: STREAMER, error: null }] },
        () => getStreamerById('streamer-1')
      )
      const { result: pgResult } = await runPg(
        { tables: new Map<Table, Array<Record<string, unknown>>>([[streamersTable, [STREAMER]]]) },
        () => getStreamerById('streamer-1')
      )

      expect(pgResult).toEqual(postgrestResult)
      expect(pgResult).toEqual(STREAMER)
    })

    it('0行では両経路とも null を返す（maybeSingle 相当）', async () => {
      const { result: postgrestResult } = await runPostgrest(
        { streamers: [{ data: null, error: null }] },
        () => getStreamerById('missing-id')
      )
      const { result: pgResult } = await runPg(
        { tables: new Map<Table, Array<Record<string, unknown>>>([[streamersTable, []]]) },
        () => getStreamerById('missing-id')
      )

      expect(postgrestResult).toBeNull()
      expect(pgResult).toBeNull()
    })
  })

  describe('getUserCardDetail', () => {
    const USER_ROW = { id: 'user-uuid-1', twitch_user_id: 'viewer-1' }

    it('所持カード: streamers（埋め込み）と streamer（別名）の両キーを含む形状が一致する', async () => {
      const { result: postgrestResult } = await runPostgrest(
        {
          cards: [{ data: { ...CARD_NEW, streamers: STREAMER }, error: null }],
          users: [{ data: { id: 'user-uuid-1' }, error: null }],
          user_cards: [{ data: null, error: null, count: 2 }],
        },
        () => getUserCardDetail('viewer-1', 'streamer-1', 'card-new')
      )
      const { result: pgResult } = await runPg(
        {
          tables: new Map<Table, Array<Record<string, unknown>>>([
            [cardsTable, [CARD_NEW]],
            [streamersTable, [STREAMER]],
            [usersTable, [USER_ROW]],
          ]),
          counts: new Map([[userCardsTable, 2]]),
        },
        () => getUserCardDetail('viewer-1', 'streamer-1', 'card-new')
      )

      expect(pgResult).toEqual(postgrestResult)
      // 既存実装は spread で埋め込みキー streamers を残したまま streamer を追加する
      expect(pgResult).toEqual({
        ...CARD_NEW,
        streamers: STREAMER,
        streamer: STREAMER,
        count: 2,
      })
    })

    it('未所持（count 0）では両経路とも null を返す', async () => {
      const { result: postgrestResult } = await runPostgrest(
        {
          cards: [{ data: { ...CARD_NEW, streamers: STREAMER }, error: null }],
          users: [{ data: { id: 'user-uuid-1' }, error: null }],
          user_cards: [{ data: null, error: null, count: 0 }],
        },
        () => getUserCardDetail('viewer-1', 'streamer-1', 'card-new')
      )
      const { result: pgResult } = await runPg(
        {
          tables: new Map<Table, Array<Record<string, unknown>>>([
            [cardsTable, [CARD_NEW]],
            [streamersTable, [STREAMER]],
            [usersTable, [USER_ROW]],
          ]),
          counts: new Map([[userCardsTable, 0]]),
        },
        () => getUserCardDetail('viewer-1', 'streamer-1', 'card-new')
      )

      expect(postgrestResult).toBeNull()
      expect(pgResult).toBeNull()
    })

    // Issue #685: getTableColumns(cardsTable) のスプレッドは本番未デプロイ8列を
    // 要求する。card 取得（.from(cardsTable)）は user/count 取得より前に完了する
    // 逐次ステップのため、エラーキューの消費順序に曖昧さがない。
    it('本番未デプロイ8列(hp等)SELECTフォールバック: CARDS_SAFE_COLUMNSで再試行し成功する', async () => {
      const { result: pgResult, db } = await runPg(
        {
          tables: new Map<Table, Array<Record<string, unknown>>>([
            [cardsTable, [CARD_NEW]],
            [streamersTable, [STREAMER]],
            [usersTable, [USER_ROW]],
          ]),
          counts: new Map([[userCardsTable, 2]]),
          errors: new Map([[cardsTable, [missingCardsBattleColumnError()]]]),
        },
        () => getUserCardDetail('viewer-1', 'streamer-1', 'card-new')
      )

      expect(pgResult).not.toBeNull()
      expect(pgResult).not.toHaveProperty('hp')
      expect(pgResult).toMatchObject({ id: 'card-new', streamer: STREAMER, count: 2 })
      const cardsCalls = db.select.mock.calls.filter((call: any[]) => {
        const fields = call[0]
        return fields && 'streamers' in fields
      })
      const lastCardsCall = cardsCalls[cardsCalls.length - 1][0]
      expect(lastCardsCall).toEqual({ ...CARDS_SAFE_COLUMNS, streamers: streamersTable })
    })

    it('カードなし（0行）では両経路とも null を返す', async () => {
      const { result: postgrestResult } = await runPostgrest(
        { cards: [{ data: null, error: null }] },
        () => getUserCardDetail('viewer-1', 'streamer-1', 'missing-card')
      )
      const { result: pgResult } = await runPg(
        {
          tables: new Map<Table, Array<Record<string, unknown>>>([
            [cardsTable, []],
            [streamersTable, [STREAMER]],
          ]),
        },
        () => getUserCardDetail('viewer-1', 'streamer-1', 'missing-card')
      )

      expect(postgrestResult).toBeNull()
      expect(pgResult).toBeNull()
    })
  })

  describe('getCollectionCompletions', () => {
    const COMPLETION_ROWS = [
      { total_cards: 8, completed_at: '2026-03-01T00:00:00.000+00:00', collection_name: null },
      { total_cards: 5, completed_at: '2026-02-01T00:00:00.000+00:00', collection_name: 'weapons' },
    ]

    it('collection_name 付きの3列が両経路で deepEqual になる（completed_at は文字列）', async () => {
      const { result: postgrestResult } = await runPostgrest(
        { collection_completions: [{ data: COMPLETION_ROWS, error: null }] },
        () => getCollectionCompletions('viewer-1', 'streamer-1')
      )
      const { result: pgResult } = await runPg(
        { tables: new Map<Table, Array<Record<string, unknown>>>([[collectionCompletionsTable, COMPLETION_ROWS]]) },
        () => getCollectionCompletions('viewer-1', 'streamer-1')
      )

      expect(pgResult).toEqual(postgrestResult)
      expect(pgResult).toEqual(COMPLETION_ROWS)
      for (const record of pgResult) {
        expect(typeof record.completed_at).toBe('string')
        expect(record.completed_at).not.toBeInstanceOf(Date)
      }
    })

    it('00064 デプロイ窓（collection_name 列欠落）では両経路とも旧列で再取得し null を補完する', async () => {
      const legacyRows = [{ total_cards: 8, completed_at: '2026-03-01T00:00:00.000+00:00' }]
      const { result: postgrestResult } = await runPostgrest(
        {
          collection_completions: [
            // 読み取りパスの列欠落は PostgreSQL の 42703
            {
              data: null,
              error: {
                code: '42703',
                message: 'column collection_completions.collection_name does not exist',
              },
            },
            { data: legacyRows, error: null },
          ],
        },
        () => getCollectionCompletions('viewer-1', 'streamer-1')
      )
      const { result: pgResult } = await runPg(
        {
          tables: new Map<Table, Array<Record<string, unknown>>>([[collectionCompletionsTable, legacyRows]]),
          errors: new Map([
            [
              collectionCompletionsTable,
              [
                // postgres.js は SQLSTATE を code に持つエラーを throw する
                Object.assign(new Error('column "collection_name" does not exist'), {
                  code: '42703',
                }),
              ],
            ],
          ]),
        },
        () => getCollectionCompletions('viewer-1', 'streamer-1')
      )

      expect(pgResult).toEqual(postgrestResult)
      expect(pgResult).toEqual([
        { total_cards: 8, completed_at: '2026-03-01T00:00:00.000+00:00', collection_name: null },
      ])
    })

    it('その他のエラーでは両経路とも空配列を返す', async () => {
      const { result: postgrestResult } = await runPostgrest(
        {
          collection_completions: [
            { data: null, error: { code: '42501', message: 'permission denied' } },
          ],
        },
        () => getCollectionCompletions('viewer-1', 'streamer-1')
      )
      const { result: pgResult } = await runPg(
        {
          tables: new Map<Table, Array<Record<string, unknown>>>([[collectionCompletionsTable, COMPLETION_ROWS]]),
          errors: new Map([
            [
              collectionCompletionsTable,
              [Object.assign(new Error('permission denied'), { code: '42501' })],
            ],
          ]),
        },
        () => getCollectionCompletions('viewer-1', 'streamer-1')
      )

      expect(postgrestResult).toEqual([])
      expect(pgResult).toEqual([])
    })
  })

  describe('フラグ分岐の分離（経路間の相互不可侵）', () => {
    it('postgrest 経路（フラグ未設定）では getDb が一切呼ばれない', async () => {
      await runPostgrest(
        { streamers: [{ data: { ...STREAMER, cards: [] }, error: null }] },
        () => getStreamerData('twitch-user-1')
      )
      expect(getDb).not.toHaveBeenCalled()
    })

    it('pg 経路では supabase-js クライアントが一切呼ばれない', async () => {
      vi.stubEnv('DB_DRIVER', 'pg-read')
      const client = createSupabaseClientMock({})
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
      const db = createDrizzleDbMock({
        tables: new Map<Table, Array<Record<string, unknown>>>([
          [streamersTable, [STREAMER]],
          [cardsTable, []],
        ]),
      })
      vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any)

      const result = await getStreamerData('twitch-user-1')

      expect(result).not.toBeNull()
      expect(client.from).not.toHaveBeenCalled()
    })
  })
})
