/**
 * #663: /api/gacha/demo (POST) の postgrest 経路 / pg 経路の互換テスト
 *
 * tests/unit/announcements-read-api-driver-parity.test.ts / twitch-sub-check-driver-parity.test.ts
 * と同じ流儀。本ルートは cards テーブルの読み取りのみのため isPgReadEnabled() で分岐する。
 *
 * 本ルートは getSupabaseAdmin() ではなく createClient()（@supabase/supabase-js）を
 * 直接呼ぶため、tests/setup.ts のグローバルモック（@/lib/supabase/admin）は効かない。
 * realtime.test.ts と同じ流儀で @supabase/supabase-js 自体をモックする
 * （broadcast は本テストでは常に false のため getSupabaseRealtimeClient 経由の
 * createClient 呼び出しは発生しない）。
 *
 * 最重要パリティ要件: cardId / streamerId のいずれの取得が失敗・0件であっても、
 * 例外を投げず「デモカードへ静かにフォールバックする」既存挙動を両経路で維持すること。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { cards as cardsTable } from '@/lib/db/schema'

const { createClientMock } = vi.hoisted(() => ({
  createClientMock: vi.fn(),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: createClientMock,
}))

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// POST は vi.mock 設定後に import する（createClient のモックを差し替えるため）
import { POST } from '@/app/api/gacha/demo/route'

function createRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/gacha/demo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ---------------------------------------------------------------------------
// fixture: 両経路に同じ行データを与える
// ---------------------------------------------------------------------------

/** id 指定取得の対象カード */
const CARD_BY_ID = {
  id: 'card-1',
  streamer_id: 'streamer-1',
  name: '指名されたカード',
  description: 'cardId 指定で取得されるカード',
  image_url: 'https://example.com/card-1.png',
  rarity: 'epic',
  rarity_order: 2,
  drop_rate: 15,
  intra_rarity_weight: 1,
  card_number: 3,
  max_issuance_count: null,
  collection_name: null,
  is_active: true,
  hp: 200,
  atk: 90,
  def: 80,
  spd: 80,
  skill_type: 'heal',
  skill_name: '回復',
  skill_power: 200,
  created_at: '2020-01-01T00:00:00.000+00:00',
  updated_at: '2020-01-01T00:00:00.000+00:00',
}

/** streamerId 指定取得のアクティブカード一覧（複数件でランダム選択を検証する） */
const STREAMER_CARDS = [
  {
    id: 'card-2',
    streamer_id: 'streamer-2',
    name: '配信者カードA',
    description: null,
    image_url: null,
    rarity: 'common',
    rarity_order: 4,
    drop_rate: 50,
    intra_rarity_weight: 1,
    card_number: null,
    max_issuance_count: null,
    collection_name: null,
    is_active: true,
    hp: 100,
    atk: 50,
    def: 40,
    spd: 60,
    skill_type: 'attack',
    skill_name: '通常攻撃',
    skill_power: 100,
    created_at: '2020-01-02T00:00:00.000+00:00',
    updated_at: '2020-01-02T00:00:00.000+00:00',
  },
  {
    id: 'card-3',
    streamer_id: 'streamer-2',
    name: '配信者カードB',
    description: null,
    image_url: null,
    rarity: 'rare',
    rarity_order: 3,
    drop_rate: 30,
    intra_rarity_weight: 1,
    card_number: null,
    max_issuance_count: null,
    collection_name: null,
    is_active: true,
    hp: 150,
    atk: 70,
    def: 60,
    spd: 70,
    skill_type: 'defense',
    skill_name: '防御強化',
    skill_power: 150,
    created_at: '2020-01-03T00:00:00.000+00:00',
    updated_at: '2020-01-03T00:00:00.000+00:00',
  },
]

// ---------------------------------------------------------------------------
// postgrest 経路のモック
// cardId 指定: from("cards").select("*").eq("id", ...).maybeSingle()
// streamerId 指定: from("cards").select("*").eq("streamer_id", ...).eq("is_active", ...)
// （eq の第1引数の列名でどちらのクエリか判別する）
// ---------------------------------------------------------------------------

function createSupabaseClientMock(config: {
  byId?: { data: unknown; error: unknown }
  byStreamer?: { data: unknown; error: unknown }
} = {}) {
  // cardId 指定のクエリは末尾で .maybeSingle() を呼ぶが、streamerId 指定のクエリは
  // .eq().eq() の戻り値をそのまま await する（.then() のみ）。呼び出し方の違いで
  // どちらのクエリかが一意に決まるため、列名の判別は不要。
  const from = vi.fn(() => {
    const builder: any = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      maybeSingle: vi.fn(() =>
        Promise.resolve(config.byId ?? { data: null, error: null })
      ),
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve(config.byStreamer ?? { data: [], error: null }).then(
          onFulfilled,
          onRejected
        ),
    }
    return builder
  })
  return { from }
}

// ---------------------------------------------------------------------------
// pg 経路のモック（twitch-sub-check-driver-parity.test.ts と同じ index 方式）
// fetchCardByIdPg / fetchActiveCardsByStreamerPg の呼び出し順に応答を割り当てる
// ---------------------------------------------------------------------------

interface DrizzleSelectCall {
  table: unknown
  whereCondition?: unknown
  limit?: number
}

function createDrizzleDbMock(
  config: { selects?: Array<{ rows?: Array<Record<string, unknown>>; error?: unknown }> } = {}
) {
  let selectIndex = 0
  const calls: DrizzleSelectCall[] = []
  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      const responses = config.selects ?? [{ rows: [] }]
      const response = responses[Math.min(selectIndex, responses.length - 1)]
      selectIndex += 1
      const resolve = () =>
        response.error
          ? Promise.reject(response.error)
          : Promise.resolve(
              (response.rows ?? []).map((row) =>
                Object.fromEntries(
                  Object.keys(fields).map((key) => [key, row[key] ?? null])
                )
              )
            )
      return {
        from: vi.fn((table: unknown) => {
          const call: DrizzleSelectCall = { table }
          calls.push(call)
          const builder: any = {
            where: vi.fn((condition: unknown) => {
              call.whereCondition = condition
              return builder
            }),
            limit: vi.fn((n: number) => {
              call.limit = n
              return {
                then: (onFulfilled: any, onRejected: any) =>
                  resolve().then(onFulfilled, onRejected),
              }
            }),
            then: (onFulfilled: any, onRejected: any) =>
              resolve().then(onFulfilled, onRejected),
          }
          return builder
        }),
      }
    }),
  }
  return { db, calls }
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any)
}

describe('/api/gacha/demo: postgrest / pg 経路の互換 (#663)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('cardId 指定・取得成功: 両経路とも同一カードを返す', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({ byId: { data: CARD_BY_ID, error: null } })
    createClientMock.mockReturnValue(client)
    const postgrestRes = await POST(createRequest({ cardId: 'card-1' }))
    const postgrestBody = await postgrestRes.json()

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ selects: [{ rows: [CARD_BY_ID] }] })
    primePgDb(pg)
    const pgRes = await POST(createRequest({ cardId: 'card-1' }))
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)
    expect(pgBody.card).toMatchObject({ id: 'card-1', name: '指名されたカード' })

    // id は主キーのため LIMIT 1（.maybeSingle() と同じ外部挙動）で取得している
    expect(pg.calls).toHaveLength(1)
    expect(pg.calls[0].table).toBe(cardsTable)
    expect(pg.calls[0].whereCondition).toEqual(eq(cardsTable.id, 'card-1'))
    expect(pg.calls[0].limit).toBe(1)
  })

  it('streamerId 指定・アクティブカードあり: 両経路とも同一カード集合からランダム選択する', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.9) // 末尾（2件目）を選ばせる

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({
      byStreamer: { data: STREAMER_CARDS, error: null },
    })
    createClientMock.mockReturnValue(client)
    const postgrestRes = await POST(createRequest({ streamerId: 'streamer-2' }))
    const postgrestBody = await postgrestRes.json()

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ selects: [{ rows: STREAMER_CARDS }] })
    primePgDb(pg)
    const pgRes = await POST(createRequest({ streamerId: 'streamer-2' }))
    const pgBody = await pgRes.json()

    expect(pgBody).toEqual(postgrestBody)
    expect(pgBody.card.id).toBe('card-3') // Math.random=0.9 → index 1 (2件目)

    expect(pg.calls).toHaveLength(1)
    expect(pg.calls[0].table).toBe(cardsTable)
    expect(pg.calls[0].whereCondition).toEqual(
      and(eq(cardsTable.streamer_id, 'streamer-2'), eq(cardsTable.is_active, true))
    )

    randomSpy.mockRestore()
  })

  it('cardId が見つからない場合: streamerId のカードにフォールバックする（両経路一致）', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({
      byId: { data: null, error: null },
      byStreamer: { data: [STREAMER_CARDS[0]], error: null },
    })
    createClientMock.mockReturnValue(client)
    const postgrestRes = await POST(
      createRequest({ cardId: 'missing-card', streamerId: 'streamer-2' })
    )
    const postgrestBody = await postgrestRes.json()

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [] }, { rows: [STREAMER_CARDS[0]] }],
    })
    primePgDb(pg)
    const pgRes = await POST(
      createRequest({ cardId: 'missing-card', streamerId: 'streamer-2' })
    )
    const pgBody = await pgRes.json()

    expect(pgBody).toEqual(postgrestBody)
    expect(pgBody.card.id).toBe('card-2')
    // cardId → streamerId の順にクエリされている（既存の分岐順どおり）
    expect(pg.calls).toHaveLength(2)
  })

  it('カード取得エラー時: 例外を投げずデモカードへ静かにフォールバックする（両経路一致）', async () => {
    // DEMO_CARDS からの選択も Math.random() に依存するため固定し、両経路で同じ
    // デモカードが選ばれるようにする（id/created_at/updated_at は
    // crypto.randomUUID() / new Date() で実行毎に変わるため比較対象から外す）
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({
      byId: { data: null, error: { message: 'boom' } },
    })
    createClientMock.mockReturnValue(client)
    const postgrestRes = await POST(createRequest({ cardId: 'card-1' }))
    const postgrestBody = await postgrestRes.json()

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ selects: [{ error: new Error('boom') }] })
    primePgDb(pg)
    const pgRes = await POST(createRequest({ cardId: 'card-1' }))
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(postgrestBody.card.streamer_id).toBe('demo')
    expect(pgBody.card.streamer_id).toBe('demo')
    expect(pgBody.card.name).toEqual(postgrestBody.card.name)

    randomSpy.mockRestore()
  })

  it('streamerId のカードが0件の場合: 両経路ともデモカードへフォールバックする', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({ byStreamer: { data: [], error: null } })
    createClientMock.mockReturnValue(client)
    const postgrestRes = await POST(createRequest({ streamerId: 'streamer-empty' }))
    const postgrestBody = await postgrestRes.json()

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ selects: [{ rows: [] }] })
    primePgDb(pg)
    const pgRes = await POST(createRequest({ streamerId: 'streamer-empty' }))
    const pgBody = await pgRes.json()

    expect(postgrestBody.card.streamer_id).toBe('demo')
    expect(pgBody.card.streamer_id).toBe('demo')
  })

  it('DB_DRIVER=pg（読み書き両方有効）でも読み取り専用のため isPgReadEnabled() 経由で pg 経路になる', async () => {
    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({ selects: [{ rows: [CARD_BY_ID] }] })
    primePgDb(pg)

    const res = await POST(createRequest({ cardId: 'card-1' }))
    const body = await res.json()

    expect(body.card.id).toBe('card-1')
    expect(createClientMock).not.toHaveBeenCalled()
  })

  it('pg 経路では supabase-js クライアントが一切呼ばれない', async () => {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ selects: [{ rows: [CARD_BY_ID] }] })
    primePgDb(pg)

    await POST(createRequest({ cardId: 'card-1' }))

    expect(createClientMock).not.toHaveBeenCalled()
  })

  it('postgrest 経路（フラグ未設定）では getDb が一切呼ばれない（挙動不変の検証）', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({ byId: { data: CARD_BY_ID, error: null } })
    createClientMock.mockReturnValue(client)

    await POST(createRequest({ cardId: 'card-1' }))

    expect(getDb).not.toHaveBeenCalled()
  })

  it('cardId も streamerId も未指定: 両経路ともDBに触れずデモカードを返す', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const postgrestRes = await POST(createRequest({}))
    const postgrestBody = await postgrestRes.json()

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock()
    primePgDb(pg)
    const pgRes = await POST(createRequest({}))
    const pgBody = await pgRes.json()

    expect(postgrestBody.card.streamer_id).toBe('demo')
    expect(pgBody.card.streamer_id).toBe('demo')
    expect(pg.calls).toHaveLength(0)
    expect(createClientMock).not.toHaveBeenCalled()
  })
})
