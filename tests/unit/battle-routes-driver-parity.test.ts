/**
 * #663: battle 系 API ルート群
 * （POST /api/battle/start, GET /api/battle/[battleId], GET /api/battle/stats）の
 * postgrest 経路 / pg 経路の互換テスト。
 *
 * tests/unit/support-inquiries-api-driver-parity.test.ts / tos-accept-driver-parity.test.ts
 * と同じ流儀（同一 fixture を両経路に与えて HTTP ステータス・レスポンス body・
 * 副作用（INSERT に渡る値）を突き合わせる）。
 *
 * フラグの使い分け（実装コメント参照）:
 * - POST /api/battle/start は battles への INSERT を含む読み書き混在ハンドラのため、
 *   ハンドラ全体が DB_DRIVER=pg のときのみ pg 経路（pg-read では postgrest のまま
 *   = getDb 不使用）。
 * - GET /api/battle/[battleId], GET /api/battle/stats は読み取り専用のため
 *   DB_DRIVER=pg-read でも pg 経路に切り替わる。
 *
 * playBattle / generateCPUOpponent は Math.random に依存するため、battle/start の
 * テストでは tests/unit/battle.test.ts と同じ手法で Math.random を固定し、両経路で
 * 同一の対戦結果になるようにする。skillTrigger 判定
 * （random() * 100 < min(spd * 10, 70)）は random = 0.99 なら常に false になり
 * スキル発動を抑止できるため、通常攻撃のみの決定的な対戦結果を作れる。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { and, desc, eq } from 'drizzle-orm'
import { POST as BATTLE_START } from '@/app/api/battle/start/route'
import { GET as BATTLE_GET } from '@/app/api/battle/[battleId]/route'
import { GET as BATTLE_STATS } from '@/app/api/battle/stats/route'
import { getSession } from '@/lib/session'
import { checkRateLimit } from '@/lib/rate-limit'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { validateCSRFToken } from '@/lib/csrf'
import { getDb } from '@/lib/db/client'
import { battles as battlesTable } from '@/lib/db/schema'

vi.mock('@/lib/session')
vi.mock('@/lib/csrf')
vi.mock('@/lib/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit')>()
  return { ...actual, checkRateLimit: vi.fn() }
})
vi.mock('@/lib/sentry/error-handler', () => ({
  reportBattleError: vi.fn(),
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}))

const mockGetSession = vi.mocked(getSession)
const mockCheckRateLimit = vi.mocked(checkRateLimit)
const mockGetSupabaseAdmin = vi.mocked(getSupabaseAdmin)
const mockValidateCSRFToken = vi.mocked(validateCSRFToken)

const MOCK_SESSION = {
  twitchUserId: 'user123',
  twitchUsername: 'testuser',
  twitchDisplayName: 'TestUser',
  twitchProfileImageUrl: '',
  broadcasterType: '' as const,
  expiresAt: Date.now() + 100000,
  version: 1,
}

const USER_ROW = { id: 'u1', twitch_user_id: 'user123' }

function allowRateLimit() {
  mockCheckRateLimit.mockResolvedValue({
    success: true,
    limit: 100,
    remaining: 99,
    reset: Date.now() + 60000,
  })
}

// ---------------------------------------------------------------------------
// postgrest 経路のモック: from() 呼び出しごとに応答キューを消費する thenable builder
// （support-inquiries-api-driver-parity.test.ts と同方式。insert 引数も記録する）
// ---------------------------------------------------------------------------

interface SupabaseResponse {
  data?: unknown
  error?: unknown
}

function createSupabaseClientMock(responses: SupabaseResponse[]) {
  let index = 0
  const insertCalls: Array<Record<string, unknown>> = []
  const from = vi.fn(() => {
    const response = responses[Math.min(index, responses.length - 1)]
    index += 1
    const result = { data: response.data ?? null, error: response.error ?? null }
    const builder: any = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      order: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      insert: vi.fn((values: Record<string, unknown>) => {
        insertCalls.push(values)
        return builder
      }),
      maybeSingle: vi.fn(() => Promise.resolve(result)),
      then: (onFulfilled: any, onRejected: any) => Promise.resolve(result).then(onFulfilled, onRejected),
    }
    return builder
  })
  return { from, insertCalls }
}

// ---------------------------------------------------------------------------
// pg 経路のモック（twitch-sub-check-driver-parity.test.ts / support-inquiries と
// 同方式）。select は「指定された列だけ」を fixture 行から射影して返し、
// leftJoin / orderBy はチェーンを維持するだけで内容は記録しない
// （row fixture 側で JOIN 結果込みの列を直接与えるため）。
// ---------------------------------------------------------------------------

interface PgSelectCall {
  fields: Record<string, unknown>
  where?: unknown
  orderBy?: unknown
  limit?: number
}

interface PgInsertCall {
  table: unknown
  values?: Record<string, unknown>
  returning?: Record<string, unknown>
}

interface PgResponse {
  rows?: Array<Record<string, unknown>>
  error?: unknown
}

function createDrizzleDbMock(config: { selects?: PgResponse[]; inserts?: PgResponse[] } = {}) {
  let selectIndex = 0
  let insertIndex = 0
  const selectCalls: PgSelectCall[] = []
  const insertCalls: PgInsertCall[] = []

  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      const call: PgSelectCall = { fields }
      selectCalls.push(call)
      const responses = config.selects ?? [{ rows: [] }]
      const response = responses[Math.min(selectIndex, responses.length - 1)]
      selectIndex += 1
      const resolve = () =>
        response.error
          ? Promise.reject(response.error)
          : Promise.resolve(
              (response.rows ?? []).map((row) =>
                Object.fromEntries(Object.keys(fields).map((key) => [key, row[key] ?? null]))
              )
            )
      const builder: any = {
        from: vi.fn(() => builder),
        leftJoin: vi.fn(() => builder),
        where: vi.fn((condition: unknown) => {
          call.where = condition
          return builder
        }),
        orderBy: vi.fn((condition: unknown) => {
          call.orderBy = condition
          return builder
        }),
        limit: vi.fn((n: number) => {
          call.limit = n
          return builder
        }),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
    insert: vi.fn((table: unknown) => {
      const call: PgInsertCall = { table }
      insertCalls.push(call)
      const responses = config.inserts ?? [{ rows: [] }]
      const response = responses[Math.min(insertIndex, responses.length - 1)]
      insertIndex += 1
      const builder: any = {
        values: vi.fn((values: Record<string, unknown>) => {
          call.values = values
          return builder
        }),
        returning: vi.fn((selection?: Record<string, unknown>) => {
          call.returning = selection
          return response.error ? Promise.reject(response.error) : Promise.resolve(response.rows ?? [])
        }),
      }
      return builder
    }),
  }
  return { db, selectCalls, insertCalls }
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any)
}

// ---------------------------------------------------------------------------
// POST /api/battle/start
// ---------------------------------------------------------------------------

describe('POST /api/battle/start（読み書き混在: DB_DRIVER=pg のときのみ pg 経路）', () => {
  const USER_CARD_ID = 'user-card-1' // user_cards.id（リクエストボディで指定する対象）
  const CARD_ID = 'card-user-1' // cards.id（user_cards.card_id が指す先）
  const STREAMER_TWITCH_ID = 'streamer-1'
  const CPU_CARD_ID = 'card-cpu-1'

  // ユーザーカード: atk=50, def=10, spd=10（先制 + 1 撃で相手を倒せる値）
  const USER_CARD_EMBED = {
    user_id: 'u1',
    card_id: CARD_ID,
    card: {
      id: CARD_ID,
      name: 'ユーザーカード',
      hp: 100,
      atk: 50,
      def: 10,
      spd: 10,
      skill_type: 'attack',
      skill_name: 'ユーザースキル',
      skill_power: 5,
      image_url: null,
      rarity: 'common',
      streamer: { twitch_user_id: STREAMER_TWITCH_ID },
    },
  }
  // fetchBattleStartUserCardPg の flat select 列名（c_ プレフィックス）に合わせた行
  const USER_CARD_FLAT_ROW = {
    user_id: 'u1',
    card_id: CARD_ID,
    c_id: CARD_ID,
    c_name: 'ユーザーカード',
    c_hp: 100,
    c_atk: 50,
    c_def: 10,
    c_spd: 10,
    c_skill_type: 'attack',
    c_skill_name: 'ユーザースキル',
    c_skill_power: 5,
    c_image_url: null,
    c_rarity: 'common',
    streamer_twitch_user_id: STREAMER_TWITCH_ID,
  }
  // CPU 候補カード: def=0 のため、先制したユーザーの一撃（atk50-def0=50）で hp10 を即撃破
  const CPU_CANDIDATE_CARD = {
    id: CPU_CARD_ID,
    name: 'CPU候補カード',
    hp: 10,
    atk: 1,
    def: 0,
    spd: 1,
    skill_type: 'attack',
    skill_name: 'CPUスキル',
    skill_power: 1,
    image_url: null,
    rarity: 'common',
    drop_rate: 0.25,
  }
  const BATTLE_INSERT_RESULT = { id: 'battle-1' }

  const originalMath = global.Math

  function createBattleStartRequest(body: Record<string, unknown> = { userCardId: USER_CARD_ID }): NextRequest {
    return new NextRequest('http://localhost:3000/api/battle/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    allowRateLimit()
    mockGetSession.mockResolvedValue(MOCK_SESSION)
    mockValidateCSRFToken.mockResolvedValue({ valid: true })

    // Math.random を固定してスキル発動を抑止し、対戦結果を決定的にする
    // （tests/unit/battle.test.ts と同じ手法。floor/その他の Math メソッドは
    // originalMath を prototype に持つオブジェクトへ委譲されるので影響しない）
    const mockMath = Object.create(originalMath)
    mockMath.random = vi.fn().mockReturnValue(0.99)
    global.Math = mockMath
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    global.Math = originalMath
  })

  it('成功時: 両経路のレスポンス body と battles への INSERT 値が一致する', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock([
      { data: USER_ROW },
      { data: USER_CARD_EMBED },
      { data: [CPU_CANDIDATE_CARD] },
      { data: BATTLE_INSERT_RESULT },
    ])
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await BATTLE_START(createBattleStartRequest())
    const postgrestBody = await postgrestRes.json()

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [USER_ROW] }, { rows: [USER_CARD_FLAT_ROW] }, { rows: [CPU_CANDIDATE_CARD] }],
      inserts: [{ rows: [BATTLE_INSERT_RESULT] }],
    })
    primePgDb(pg)
    const pgRes = await BATTLE_START(createBattleStartRequest())
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)
    // Math.random 固定によりスキル不発動・通常攻撃のみで 1 撃 KO になる決定的な結果
    expect(pgBody).toEqual(
      expect.objectContaining({ battleId: 'battle-1', result: 'win', turnCount: 1 })
    )
    expect(pgBody.opponentCard.id).toBe(`cpu-${CPU_CARD_ID}`)

    // battles への INSERT 値のパリティ（対戦結果の二重記録防止の要である insert 引数
    // 自体が両経路で完全一致することを確認する）
    expect(pg.insertCalls).toHaveLength(1)
    expect(pg.insertCalls[0].table).toBe(battlesTable)
    expect(pg.insertCalls[0].values).toEqual(client.insertCalls[0])
    expect(pg.insertCalls[0].values).toEqual({
      user_id: 'u1',
      user_card_id: USER_CARD_ID,
      opponent_card_id: null, // CPU 対戦のため null
      opponent_card_data: expect.objectContaining({ id: `cpu-${CPU_CARD_ID}` }),
      result: 'win',
      turn_count: 1,
      battle_log: expect.any(Array),
    })
  })

  it('CPU 候補カードが 0 件: 両経路ともデフォルト CPU カードにフォールバックする', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock([
      { data: USER_ROW },
      { data: USER_CARD_EMBED },
      { data: [] },
      { data: BATTLE_INSERT_RESULT },
    ])
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await BATTLE_START(createBattleStartRequest())
    const postgrestBody = await postgrestRes.json()

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [USER_ROW] }, { rows: [USER_CARD_FLAT_ROW] }, { rows: [] }],
      inserts: [{ rows: [BATTLE_INSERT_RESULT] }],
    })
    primePgDb(pg)
    const pgRes = await BATTLE_START(createBattleStartRequest())
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgBody).toEqual(postgrestBody)
    expect(pgBody.opponentCard.id).toBe('cpu-default')
  })

  it('CPU 候補カード取得失敗: 両経路とも 500 + 同一 body', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock([
      { data: USER_ROW },
      { data: USER_CARD_EMBED },
      { error: { message: 'boom' } },
    ])
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await BATTLE_START(createBattleStartRequest())

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [
        { rows: [USER_ROW] },
        { rows: [USER_CARD_FLAT_ROW] },
        { error: { code: '42601', message: 'syntax error' } },
      ],
    })
    primePgDb(pg)
    const pgRes = await BATTLE_START(createBattleStartRequest())

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(500)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
  })

  it('user_card 未所持（0 行）: 両経路とも 500 + 同一 body（INSERT は実行されない）', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock([{ data: USER_ROW }, { data: null }])
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await BATTLE_START(createBattleStartRequest())

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({ selects: [{ rows: [USER_ROW] }, { rows: [] }] })
    primePgDb(pg)
    const pgRes = await BATTLE_START(createBattleStartRequest())

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(500)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
    expect(pg.insertCalls).toHaveLength(0)
  })

  it('battles への INSERT 失敗: 両経路とも 500 + 同一 body（二重記録防止のためリトライされない）', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock([
      { data: USER_ROW },
      { data: USER_CARD_EMBED },
      { data: [CPU_CANDIDATE_CARD] },
      { error: { message: 'boom' } },
    ])
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await BATTLE_START(createBattleStartRequest())

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [USER_ROW] }, { rows: [USER_CARD_FLAT_ROW] }, { rows: [CPU_CANDIDATE_CARD] }],
      inserts: [{ error: { code: '23505', message: 'duplicate key' } }],
    })
    primePgDb(pg)
    const pgRes = await BATTLE_START(createBattleStartRequest())

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(500)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
  })

  it('未認証: 両経路とも 401（フラグに依らず同一）、getDb は呼ばれない', async () => {
    mockGetSession.mockResolvedValue(null)
    for (const driver of [undefined, 'pg']) {
      vi.stubEnv('DB_DRIVER', driver)
      const res = await BATTLE_START(createBattleStartRequest())
      expect(res.status).toBe(401)
    }
    expect(getDb).not.toHaveBeenCalled()
  })

  it('DB_DRIVER=pg-read では書き込み混在ハンドラのため postgrest 経路のまま（getDb 不使用）', async () => {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const client = createSupabaseClientMock([
      { data: USER_ROW },
      { data: USER_CARD_EMBED },
      { data: [CPU_CANDIDATE_CARD] },
      { data: BATTLE_INSERT_RESULT },
    ])
    mockGetSupabaseAdmin.mockReturnValue(client as any)

    const res = await BATTLE_START(createBattleStartRequest())
    expect(res.status).toBe(200)
    expect(getDb).not.toHaveBeenCalled()
  })

  it('フラグ未設定時は getDb が一切呼ばれない（挙動不変の検証）', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock([
      { data: USER_ROW },
      { data: USER_CARD_EMBED },
      { data: [CPU_CANDIDATE_CARD] },
      { data: BATTLE_INSERT_RESULT },
    ])
    mockGetSupabaseAdmin.mockReturnValue(client as any)

    await BATTLE_START(createBattleStartRequest())
    expect(getDb).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// GET /api/battle/[battleId]
// ---------------------------------------------------------------------------

describe('GET /api/battle/[battleId]（読み取り専用: DB_DRIVER=pg-read でも pg 経路）', () => {
  const BATTLE_ID = 'battle-1'

  function createGetRequest(): NextRequest {
    return new NextRequest(`http://localhost:3000/api/battle/${BATTLE_ID}`)
  }

  function run(driver: string | undefined) {
    vi.stubEnv('DB_DRIVER', driver)
    return BATTLE_GET(createGetRequest(), { params: Promise.resolve({ battleId: BATTLE_ID }) })
  }

  // 実運用データ（PostgREST の to-one 埋め込みは battle/stats route が正しく前提と
  // している通り「オブジェクト」で返る。battle/[battleId] route の既存コードは
  // .length / [0] というアレイ前提でアクセスするため（ファイル冒頭の
  // getBattleQueryResultPg doc コメント参照）、実運用データでは両経路とも
  // userCardDataRaw[0] が undefined になり TypeError → 500 に落ちる（本移行の
  // 範囲外の既存バグだが、pg 経路もこれを忠実に再現しているため両経路の外部挙動は
  // 一致する。実際にこのテストファイル作成時に probe テストで実証済み）。
  const REAL_USER_CARD = {
    id: 'card-1',
    name: 'ユーザーカード',
    hp: 100,
    atk: 50,
    def: 10,
    spd: 10,
    skill_type: 'attack',
    skill_name: 'スキル',
    skill_power: 5,
    image_url: null,
    rarity: 'common',
  }
  const BATTLE_ROW_OBJECT_SHAPE = {
    id: BATTLE_ID,
    result: 'win',
    turn_count: 3,
    battle_log: [],
    user_card: {
      user_id: 'u1',
      card_id: 'card-1',
      obtained_at: '2026-01-01 00:00:00+00',
      card: { ...REAL_USER_CARD, streamer: { twitch_user_id: 'streamer-1' } },
    },
    opponent_card: {
      id: 'opp-1',
      name: 'Opponent',
      hp: 100,
      atk: 40,
      def: 20,
      spd: 8,
      skill_type: 'attack',
      skill_name: 'Opp Skill',
      skill_power: 8,
      image_url: null,
      rarity: 'rare',
    },
  }
  const FLAT_BATTLE_ROW = {
    id: BATTLE_ID,
    result: 'win',
    turn_count: 3,
    battle_log: [],
    uc_user_id: 'u1',
    uc_card_id: 'card-1',
    uc_obtained_at: '2026-01-01 00:00:00+00',
    card_id: 'card-1',
    card_name: REAL_USER_CARD.name,
    card_hp: REAL_USER_CARD.hp,
    card_atk: REAL_USER_CARD.atk,
    card_def: REAL_USER_CARD.def,
    card_spd: REAL_USER_CARD.spd,
    card_skill_type: REAL_USER_CARD.skill_type,
    card_skill_name: REAL_USER_CARD.skill_name,
    card_skill_power: REAL_USER_CARD.skill_power,
    card_image_url: REAL_USER_CARD.image_url,
    card_rarity: REAL_USER_CARD.rarity,
    streamer_twitch_user_id: 'streamer-1',
    opp_id: 'opp-1',
    opp_name: 'Opponent',
    opp_hp: 100,
    opp_atk: 40,
    opp_def: 20,
    opp_spd: 8,
    opp_skill_type: 'attack',
    opp_skill_name: 'Opp Skill',
    opp_skill_power: 8,
    opp_image_url: null,
    opp_rarity: 'rare',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    allowRateLimit()
    mockGetSession.mockResolvedValue(MOCK_SESSION)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('実運用形状（埋め込みがオブジェクト）: 両経路とも同一の 500（既存の array-access バグを両経路で再現）', async () => {
    const client = createSupabaseClientMock([{ data: USER_ROW }, { data: BATTLE_ROW_OBJECT_SHAPE }])
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await run(undefined)
    const postgrestBody = await postgrestRes.json()

    const pg = createDrizzleDbMock({ selects: [{ rows: [USER_ROW] }, { rows: [FLAT_BATTLE_ROW] }] })
    primePgDb(pg)
    const pgRes = await run('pg-read')
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(500)
    expect(pgBody).toEqual(postgrestBody)
    expect(pgBody).toEqual({ error: 'Internal server error' })

    // 所有権チェック込みの where + PRIMARY KEY 根拠の limit(1)
    expect(pg.selectCalls[1].where).toEqual(
      and(eq(battlesTable.id, BATTLE_ID), eq(battlesTable.user_id, 'u1'))
    )
    expect(pg.selectCalls[1].limit).toBe(1)
  })

  it('ユーザー不在: 両経路とも 500 + 同一 body', async () => {
    const client = createSupabaseClientMock([{ data: null }])
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await run(undefined)

    const pg = createDrizzleDbMock({ selects: [{ rows: [] }] })
    primePgDb(pg)
    const pgRes = await run('pg-read')

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(500)
    const pgBody = await pgRes.json()
    expect(pgBody).toEqual(await postgrestRes.json())
    expect(pgBody).toEqual({ error: 'Database error' })
  })

  it('対戦が存在しない（0 行）: 両経路とも 500 + 同一 body', async () => {
    const client = createSupabaseClientMock([{ data: USER_ROW }, { data: null }])
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await run(undefined)

    const pg = createDrizzleDbMock({ selects: [{ rows: [USER_ROW] }, { rows: [] }] })
    primePgDb(pg)
    const pgRes = await run('pg-read')

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(500)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
  })

  it('battles 取得失敗: 両経路とも 500 + 同一 body', async () => {
    const client = createSupabaseClientMock([{ data: USER_ROW }, { error: { message: 'boom' } }])
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await run(undefined)

    const pg = createDrizzleDbMock({
      selects: [{ rows: [USER_ROW] }, { error: { code: '42601', message: 'syntax error' } }],
    })
    primePgDb(pg)
    const pgRes = await run('pg-read')

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(500)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
  })

  it('未認証: 両経路とも 401、getDb は呼ばれない', async () => {
    mockGetSession.mockResolvedValue(null)
    for (const driver of [undefined, 'pg-read']) {
      const res = await run(driver)
      expect(res.status).toBe(401)
    }
    expect(getDb).not.toHaveBeenCalled()
  })

  it('フラグ未設定時は getDb が一切呼ばれない（挙動不変の検証）', async () => {
    const client = createSupabaseClientMock([{ data: USER_ROW }, { data: BATTLE_ROW_OBJECT_SHAPE }])
    mockGetSupabaseAdmin.mockReturnValue(client as any)

    await run(undefined)
    expect(getDb).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// GET /api/battle/stats
// ---------------------------------------------------------------------------

describe('GET /api/battle/stats（読み取り専用: DB_DRIVER=pg-read でも pg 経路）', () => {
  const BATTLE_STATS_ROW = {
    id: 'bs-1',
    total_battles: 5,
    wins: 3,
    losses: 1,
    draws: 1,
    win_rate: 60,
    updated_at: '2026-01-01T00:00:00.000+00:00',
  }

  const PG_TEXT_TIMESTAMP = '2026-02-01 00:00:00.000+00'
  const PG_TEXT_TIMESTAMP_ISO = '2026-02-01T00:00:00.000Z'

  const RECENT_BATTLE_ROW = {
    id: 'battle-1',
    result: 'win',
    turn_count: 2,
    battle_log: [],
    created_at: PG_TEXT_TIMESTAMP_ISO,
    user_card: {
      user_id: 'u1',
      card_id: 'card-1',
      obtained_at: '2026-01-01T00:00:00.000+00:00',
      card: {
        id: 'card-1',
        name: 'カードA',
        hp: 100,
        atk: 50,
        def: 10,
        spd: 10,
        skill_type: 'attack',
        skill_name: 'スキル',
        skill_power: 5,
        image_url: null,
        rarity: 'common',
        streamer: { twitch_user_id: 'streamer-1' },
      },
    },
    opponent_card: { id: 'opp-1', name: '相手' },
  }

  const CARD_STATS_ROW = {
    result: 'win',
    user_card: RECENT_BATTLE_ROW.user_card,
  }

  const FLAT_USER_CARD_EMBED = {
    uc_user_id: 'u1',
    uc_card_id: 'card-1',
    uc_obtained_at: '2026-01-01 00:00:00+00',
    card_id: 'card-1',
    card_name: 'カードA',
    card_hp: 100,
    card_atk: 50,
    card_def: 10,
    card_spd: 10,
    card_skill_type: 'attack',
    card_skill_name: 'スキル',
    card_skill_power: 5,
    card_image_url: null,
    card_rarity: 'common',
    streamer_twitch_user_id: 'streamer-1',
  }

  const FLAT_RECENT_BATTLE_ROW = {
    id: 'battle-1',
    result: 'win',
    turn_count: 2,
    battle_log: [],
    // PG テキスト形式（実装が new Date(x).toISOString() で正規化する対象）
    created_at: PG_TEXT_TIMESTAMP,
    ...FLAT_USER_CARD_EMBED,
    opp_id: 'opp-1',
    opp_name: '相手',
  }

  const FLAT_CARD_STATS_ROW = {
    result: 'win',
    ...FLAT_USER_CARD_EMBED,
  }

  function createGetRequest(): NextRequest {
    return new NextRequest('http://localhost:3000/api/battle/stats')
  }

  function run(driver: string | undefined) {
    vi.stubEnv('DB_DRIVER', driver)
    return BATTLE_STATS(createGetRequest())
  }

  beforeEach(() => {
    vi.clearAllMocks()
    allowRateLimit()
    mockGetSession.mockResolvedValue(MOCK_SESSION)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('成功時: 両経路のレスポンス body が完全一致する（created_at の ISO 正規化込み）', async () => {
    const client = createSupabaseClientMock([
      { data: USER_ROW },
      { data: BATTLE_STATS_ROW },
      { data: [RECENT_BATTLE_ROW] },
      { data: [CARD_STATS_ROW] },
    ])
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await run(undefined)
    const postgrestBody = await postgrestRes.json()

    const pg = createDrizzleDbMock({
      selects: [
        { rows: [USER_ROW] },
        { rows: [BATTLE_STATS_ROW] },
        { rows: [FLAT_RECENT_BATTLE_ROW] },
        { rows: [FLAT_CARD_STATS_ROW] },
      ],
    })
    primePgDb(pg)
    const pgRes = await run('pg-read')
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)
    expect(pgBody).toEqual(
      expect.objectContaining({
        totalBattles: 5,
        wins: 3,
        losses: 1,
        draws: 1,
        winRate: 60,
      })
    )
    expect(pgBody.recentBattles[0].createdAt).toBe(PG_TEXT_TIMESTAMP_ISO)
    expect(pgBody.cardStats).toHaveLength(1)
    expect(pgBody.cardStats[0]).toEqual(
      expect.objectContaining({ cardId: 'card-1', totalBattles: 1, wins: 1 })
    )

    // recentBattles: order/limit のパリティ（.order('created_at', {ascending:false}).limit(10)）
    expect(pg.selectCalls[2].orderBy).toEqual(desc(battlesTable.created_at))
    expect(pg.selectCalls[2].limit).toBe(10)
    // cardStats: PostgREST サーバ max-rows 既定(1000件)との揃え
    expect(pg.selectCalls[3].limit).toBe(1000)
  })

  it('created_at がパース不能な値でも 500 落ちせず、元の文字列をそのまま返す（pg経路のみ）', async () => {
    // レビュー指摘の回帰テスト: normalizePgTimestamp 導入前は
    // new Date(row.created_at).toISOString() を直接呼んでおり、
    // パース不能な値だと RangeError: Invalid time value を投げて
    // API 全体が 500 になっていた。postgrest 経路は created_at を
    // 変換せず素通しするため、この異常値ケースの比較対象は存在しない
    // （pg 経路単体の安全性を検証する）。
    const INVALID_TIMESTAMP = 'not-a-valid-timestamp'
    const pg = createDrizzleDbMock({
      selects: [
        { rows: [USER_ROW] },
        { rows: [BATTLE_STATS_ROW] },
        { rows: [{ ...FLAT_RECENT_BATTLE_ROW, created_at: INVALID_TIMESTAMP }] },
        { rows: [FLAT_CARD_STATS_ROW] },
      ],
    })
    primePgDb(pg)

    const pgRes = await run('pg-read')

    expect(pgRes.status).toBe(200)
    const pgBody = await pgRes.json()
    // Date.parse できない値は正規化せず元の文字列のまま返す（安全側のフォールバック）
    expect(pgBody.recentBattles[0].createdAt).toBe(INVALID_TIMESTAMP)
  })

  it('battle_stats 行が存在しない（未対戦ユーザー）: 両経路ともデフォルト統計を返す', async () => {
    const client = createSupabaseClientMock([
      { data: USER_ROW },
      { data: null },
      { data: [] },
      { data: [] },
    ])
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await run(undefined)
    const postgrestBody = await postgrestRes.json()

    const pg = createDrizzleDbMock({
      selects: [{ rows: [USER_ROW] }, { rows: [] }, { rows: [] }, { rows: [] }],
    })
    primePgDb(pg)
    const pgRes = await run('pg-read')
    const pgBody = await pgRes.json()

    expect(pgBody).toEqual(postgrestBody)
    expect(pgBody).toEqual(
      expect.objectContaining({ totalBattles: 0, wins: 0, losses: 0, draws: 0, winRate: 0 })
    )
  })

  it('ユーザー不在: 両経路とも 500 + 同一 body', async () => {
    const client = createSupabaseClientMock([{ data: null }])
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await run(undefined)

    const pg = createDrizzleDbMock({ selects: [{ rows: [] }] })
    primePgDb(pg)
    const pgRes = await run('pg-read')

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(500)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
  })

  it('recentBattles 取得失敗: 両経路とも 500 + 同一 body', async () => {
    const client = createSupabaseClientMock([
      { data: USER_ROW },
      { data: BATTLE_STATS_ROW },
      { error: { message: 'boom' } },
    ])
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await run(undefined)

    const pg = createDrizzleDbMock({
      selects: [
        { rows: [USER_ROW] },
        { rows: [BATTLE_STATS_ROW] },
        { error: { code: '42601', message: 'syntax error' } },
      ],
    })
    primePgDb(pg)
    const pgRes = await run('pg-read')

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(500)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
  })

  it('cardStats 取得失敗: 両経路とも 500 + 同一 body', async () => {
    const client = createSupabaseClientMock([
      { data: USER_ROW },
      { data: BATTLE_STATS_ROW },
      { data: [RECENT_BATTLE_ROW] },
      { error: { message: 'boom' } },
    ])
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await run(undefined)

    const pg = createDrizzleDbMock({
      selects: [
        { rows: [USER_ROW] },
        { rows: [BATTLE_STATS_ROW] },
        { rows: [FLAT_RECENT_BATTLE_ROW] },
        { error: { code: '42601', message: 'syntax error' } },
      ],
    })
    primePgDb(pg)
    const pgRes = await run('pg-read')

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(500)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
  })

  it('未認証: 両経路とも 401、getDb は呼ばれない', async () => {
    mockGetSession.mockResolvedValue(null)
    for (const driver of [undefined, 'pg-read']) {
      const res = await run(driver)
      expect(res.status).toBe(401)
    }
    expect(getDb).not.toHaveBeenCalled()
  })

  it('フラグ未設定時は getDb が一切呼ばれない（挙動不変の検証）', async () => {
    const client = createSupabaseClientMock([
      { data: USER_ROW },
      { data: BATTLE_STATS_ROW },
      { data: [RECENT_BATTLE_ROW] },
      { data: [CARD_STATS_ROW] },
    ])
    mockGetSupabaseAdmin.mockReturnValue(client as any)

    await run(undefined)
    expect(getDb).not.toHaveBeenCalled()
  })
})
