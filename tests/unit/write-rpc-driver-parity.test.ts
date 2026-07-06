/**
 * #573 残り: 書き込み系 RPC 4件の postgrest 経路 / pg 直結経路 ドライバ切替パリティテスト
 *   1. batch_update_card_drop_rates (src/lib/recalculate-drop-rates.ts,
 *      src/app/api/cards/batch-update/route.ts)
 *   2. rename_card_pack (src/app/api/cards/collections/route.ts, PATCH)
 *   3. activate_support_code (src/app/api/support/activate/route.ts)
 *   4. deactivate_all_licenses (src/app/api/support/deactivate/route.ts)
 *
 * 各 RPC について以下を固定する(既存 parity テストと同じ観点。
 * tests/unit/gacha-rpc-driver-parity.test.ts / dashboard-data-rpc-driver-parity.test.ts
 * / storage-db-driver-parity.test.ts の流儀を踏襲):
 *   1. postgrest 経路(フラグ未設定 = 既定 'postgrest'): getDb が一切呼ばれず
 *      既存 .rpc() 呼び出しの引数・外部挙動が完全に不変
 *   2. pg 経路(DB_DRIVER=pg): 名前付き引数 + 明示キャストの SQL が実行され、
 *      戻り値/エラーが PostgREST .rpc() と同一形状に正規化される
 *   3. 冪等性設定: 非冪等 RPC (rename_card_pack / activate_support_code) は
 *      接続断(CONNECTION_CLOSED)でもリトライされず即エラーになること。
 *      冪等 RPC (batch_update_card_drop_rates / deactivate_all_licenses) は
 *      接続断後にリトライして成功すること
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { executeBatchUpdateCardDropRatesRpcPg, recalculateIfAutoMode } from '@/lib/recalculate-drop-rates'
import { POST as batchUpdatePost } from '@/app/api/cards/batch-update/route'
import { PATCH as collectionsPatch } from '@/app/api/cards/collections/route'
import { POST as activatePost } from '@/app/api/support/activate/route'
import { POST as deactivatePost } from '@/app/api/support/deactivate/route'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { checkRateLimit, getRateLimitIdentifier } from '@/lib/rate-limit'
import { validateCSRFToken } from '@/lib/csrf'
import { validateContentType } from '@/lib/request-validation'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getDb } from '@/lib/db/client'
import { createMockQueryBuilder } from '../utils/supabase-mock'

vi.mock('@/lib/session')
vi.mock('@/lib/rate-limit')
vi.mock('@/lib/csrf')
vi.mock('@/lib/request-validation')
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/sentry/error-handler')
vi.mock('@/lib/crypto-utils', () => ({
  sha256: vi.fn().mockResolvedValue('hashed-code-value'),
}))
vi.mock('@/lib/supabase/admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/admin')>()
  return { ...actual, getSupabaseAdmin: vi.fn() }
})

const mockGetSession = vi.mocked(getSession)
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures)
const mockCheckRateLimit = vi.mocked(checkRateLimit)
const mockGetRateLimitIdentifier = vi.mocked(getRateLimitIdentifier)
const mockValidateCSRFToken = vi.mocked(validateCSRFToken)
const mockValidateContentType = vi.mocked(validateContentType)
const mockGetSupabaseAdmin = vi.mocked(getSupabaseAdmin)

const SESSION = {
  twitchUserId: 'twitch-user-123',
  twitchUsername: 'testuser',
  twitchDisplayName: 'Test User',
  twitchProfileImageUrl: 'https://example.com/avatar.jpg',
  broadcasterType: 'affiliate',
  expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
  version: 1,
}

/**
 * postgres.js の sql タグ呼び出し(sql`...${v}...`)を模したモック。
 * 呼び出しごとに responses を1つずつ消費し、最後の要素は使い切った後も
 * 繰り返し返す(gacha-rpc-driver-parity.test.ts の createSqlMock と同じ流儀)。
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
 * 取り出す(実 postgres.js は $1..$n を割り当てる)。gacha-rpc-driver-parity.test.ts
 * / dashboard-data-rpc-driver-parity.test.ts と同じ流儀。
 */
function renderSqlCall(sqlMock: ReturnType<typeof vi.fn>, index: number) {
  const [strings, ...values] = sqlMock.mock.calls[index] as [readonly string[], ...unknown[]]
  return { text: strings.join('$'), values }
}

function primePgDb(sqlMock: ReturnType<typeof createSqlMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: {} as never, sql: sqlMock as never })
}

function setDefaultAuthMocks() {
  mockGetSession.mockResolvedValue(SESSION as any)
  mockCanUseStreamerFeatures.mockReturnValue(true)
  mockCheckRateLimit.mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: Date.now() + 60000 })
  mockGetRateLimitIdentifier.mockResolvedValue('user:twitch-user-123')
  mockValidateCSRFToken.mockResolvedValue({ valid: true })
  mockValidateContentType.mockReturnValue(null)
}

beforeEach(() => {
  vi.clearAllMocks()
  setDefaultAuthMocks()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// =============================================================================
// 1. batch_update_card_drop_rates
// =============================================================================

describe('batch_update_card_drop_rates (#573)', () => {
  describe('executeBatchUpdateCardDropRatesRpcPg (共有 pg 実装)', () => {
    it('正常系: 名前付き引数(::uuid / ::jsonb 明示キャスト)で呼ばれ、jsonb 戻り値がそのまま得られる', async () => {
      const sqlMock = createSqlMock([{ rows: [{ result: { updated_count: 2 } }] }])
      primePgDb(sqlMock)

      const updates = [
        { id: 'card-1', drop_rate: 0.5 },
        { id: 'card-2', drop_rate: 0.3 },
      ]
      const result = await executeBatchUpdateCardDropRatesRpcPg('streamer-1', updates)

      expect(result).toEqual({ data: { updated_count: 2 }, error: null })
      expect(sqlMock).toHaveBeenCalledTimes(1)
      const { text, values } = renderSqlCall(sqlMock, 0)
      expect(text).toContain('batch_update_card_drop_rates')
      expect(text).toContain('p_streamer_id => $::uuid')
      expect(text).toContain('p_updates => $::jsonb')
      expect(values).toEqual(['streamer-1', JSON.stringify(updates)])
    })

    it('エラーは 42883 を含め特別扱いせず code/message をそのまま正規化する(呼び出し元2箇所に既存の42883フォールバックが無いため)', async () => {
      const sqlMock = createSqlMock([
        { reject: pgError('42883', 'function batch_update_card_drop_rates(uuid, jsonb) does not exist') },
      ])
      primePgDb(sqlMock)

      const result = await executeBatchUpdateCardDropRatesRpcPg('streamer-1', [{ id: 'card-1', drop_rate: 0.5 }])

      expect(result.data).toBeNull()
      expect(result.error).toEqual({
        code: '42883',
        message: 'function batch_update_card_drop_rates(uuid, jsonb) does not exist',
      })
    })

    it('冪等リトライ: CONNECTION_CLOSED 後にリトライして成功する(idempotent:true — 同一値へのUPDATEのみのため)', async () => {
      const sqlMock = createSqlMock([
        { reject: pgError('CONNECTION_CLOSED', 'write CONNECTION_CLOSED') },
        { rows: [{ result: { updated_count: 1 } }] },
      ])
      primePgDb(sqlMock)

      const result = await executeBatchUpdateCardDropRatesRpcPg('streamer-1', [{ id: 'card-1', drop_rate: 0.5 }])

      expect(result).toEqual({ data: { updated_count: 1 }, error: null })
      expect(sqlMock).toHaveBeenCalledTimes(2)
    })
  })

  describe('recalculateIfAutoMode (pg 分岐)', () => {
    const RARITY_WEIGHTS = { common: 100 }
    const ACTIVE_CARDS = [{ id: 'card-1', rarity: 'common', is_active: true, intra_rarity_weight: 1 }]
    const RECALCULATED_CARDS = [{ id: 'card-1', streamer_id: 'streamer-1', drop_rate: 1, rarity: 'common' }]

    function createSupabaseAdminMock(rpc: ReturnType<typeof vi.fn>) {
      let cardsCallCount = 0
      const from = vi.fn((table: string) => {
        expect(table).toBe('cards')
        cardsCallCount += 1
        const data = cardsCallCount === 1 ? ACTIVE_CARDS : RECALCULATED_CARDS
        const qb = createMockQueryBuilder()
        ;(qb as unknown as Record<string, unknown>).then = (resolve: (v: unknown) => void) => {
          resolve({ data, error: null })
          return qb
        }
        return qb
      })
      return { from, rpc }
    }

    it('postgrest 経路(フラグ未設定): 既存 supabase-js RPC で実行され getDb は呼ばれない', async () => {
      const rpc = vi.fn().mockResolvedValue({ data: { updated_count: 1 }, error: null })
      const supabaseAdmin = createSupabaseAdminMock(rpc)

      const result = await recalculateIfAutoMode(supabaseAdmin as any, 'streamer-1', RARITY_WEIGHTS)

      expect(result).toEqual(RECALCULATED_CARDS)
      expect(rpc).toHaveBeenCalledWith('batch_update_card_drop_rates', {
        p_streamer_id: 'streamer-1',
        p_updates: [{ id: 'card-1', drop_rate: 1 }],
      })
      expect(getDb).not.toHaveBeenCalled()
    })

    it('pg 経路(DB_DRIVER=pg): executeBatchUpdateCardDropRatesRpcPg 経由で実行され supabase rpc は不呼出', async () => {
      vi.stubEnv('DB_DRIVER', 'pg')
      const rpc = vi.fn()
      const supabaseAdmin = createSupabaseAdminMock(rpc)
      const sqlMock = createSqlMock([{ rows: [{ result: { updated_count: 1 } }] }])
      primePgDb(sqlMock)

      const result = await recalculateIfAutoMode(supabaseAdmin as any, 'streamer-1', RARITY_WEIGHTS)

      expect(result).toEqual(RECALCULATED_CARDS)
      expect(sqlMock).toHaveBeenCalledTimes(1)
      const { values } = renderSqlCall(sqlMock, 0)
      expect(values).toEqual(['streamer-1', JSON.stringify([{ id: 'card-1', drop_rate: 1 }])])
      expect(rpc).not.toHaveBeenCalled()
    })
  })

  describe('POST /api/cards/batch-update (pg 分岐)', () => {
    function createRequest(body: Record<string, unknown>): NextRequest {
      return new NextRequest('http://localhost:3000/api/cards/batch-update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    }

    /** streamers → cards(所有権確認) → cards(更新後データ取得) の順で呼ばれる */
    function createBatchUpdateSupabaseMock(options: {
      rpc?: ReturnType<typeof vi.fn>
      updatedCards?: Record<string, unknown>[]
    }) {
      let fromCallCount = 0
      const from = vi.fn((table: string) => {
        fromCallCount += 1
        if (table === 'streamers') {
          const qb = createMockQueryBuilder()
          ;(qb.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
            data: { id: 'streamer-1', rarity_weights: null },
            error: null,
          })
          return qb
        }
        // cards: 1st call = ownership check, 2nd call = post-update fetch
        const qb = createMockQueryBuilder()
        const data = fromCallCount === 2 ? [{ id: 'card-1' }] : (options.updatedCards ?? [{ id: 'card-1' }])
        const resultPromise = Promise.resolve({ data, error: null })
        ;(qb.in as ReturnType<typeof vi.fn>).mockReturnValue({
          ...qb,
          then: resultPromise.then.bind(resultPromise),
        })
        return qb
      })
      const rpc = options.rpc ?? vi.fn()
      mockGetSupabaseAdmin.mockReturnValue({ from, rpc } as unknown as ReturnType<typeof getSupabaseAdmin>)
      return { from, rpc }
    }

    it('postgrest 経路(フラグ未設定): 既存 supabase-js RPC で実行され getDb は呼ばれない', async () => {
      const rpc = vi.fn().mockResolvedValue({ data: { updated_count: 1 }, error: null })
      createBatchUpdateSupabaseMock({ rpc, updatedCards: [{ id: 'card-1', drop_rate: 0.5 }] })

      const response = await batchUpdatePost(
        createRequest({ streamerId: 'streamer-1', updates: [{ id: 'card-1', dropRate: 0.5 }] })
      )

      expect(response.status).toBe(200)
      expect(rpc).toHaveBeenCalledWith('batch_update_card_drop_rates', {
        p_streamer_id: 'streamer-1',
        p_updates: [{ id: 'card-1', drop_rate: 0.5 }],
      })
      expect(getDb).not.toHaveBeenCalled()
    })

    it('pg 経路(DB_DRIVER=pg): 名前付き引数の SQL が実行され、レスポンス形状が postgrest 経路と一致する', async () => {
      vi.stubEnv('DB_DRIVER', 'pg')
      const rpc = vi.fn()
      createBatchUpdateSupabaseMock({ rpc, updatedCards: [{ id: 'card-1', drop_rate: 0.5 }] })
      const sqlMock = createSqlMock([{ rows: [{ result: { updated_count: 1 } }] }])
      primePgDb(sqlMock)

      const response = await batchUpdatePost(
        createRequest({ streamerId: 'streamer-1', updates: [{ id: 'card-1', dropRate: 0.5 }] })
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toMatchObject({ success: true, updated: 1 })
      expect(sqlMock).toHaveBeenCalledTimes(1)
      const { text } = renderSqlCall(sqlMock, 0)
      expect(text).toContain('batch_update_card_drop_rates')
      // 書き込み RPC が postgrest 経路(rpc)へ流れていないこと
      expect(rpc).not.toHaveBeenCalled()
    })

    it('pg 経路で RPC エラー: 既存と同じ 500 (handleDatabaseError) を返す', async () => {
      vi.stubEnv('DB_DRIVER', 'pg')
      createBatchUpdateSupabaseMock({})
      const sqlMock = createSqlMock([{ reject: pgError('XX000', 'unexpected database error') }])
      primePgDb(sqlMock)

      const response = await batchUpdatePost(
        createRequest({ streamerId: 'streamer-1', updates: [{ id: 'card-1', dropRate: 0.5 }] })
      )

      expect(response.status).toBe(500)
    })
  })
})

// =============================================================================
// 2. rename_card_pack
// =============================================================================

describe('rename_card_pack (#573)', () => {
  function makePatchRequest(body: unknown) {
    return new NextRequest('http://localhost/api/cards/collections', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  function mockAdminForPatch(opts: { streamer?: { id: string; card_pack_names?: string[] } | null; rpc?: ReturnType<typeof vi.fn> }) {
    const streamerQuery = createMockQueryBuilder()
    ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: opts.streamer ?? null,
      error: null,
    })
    const rpc = opts.rpc ?? vi.fn().mockResolvedValue({ data: null, error: null })
    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn(() => streamerQuery),
      rpc,
    } as unknown as ReturnType<typeof getSupabaseAdmin>)
    return { streamerQuery, rpc }
  }

  const CATALOG_STREAMER = { id: 'streamer-1', card_pack_names: ['weapons', 'characters'] }

  it('postgrest 経路(フラグ未設定): 既存 supabase-js RPC で実行され getDb は呼ばれない', async () => {
    const { rpc } = mockAdminForPatch({ streamer: CATALOG_STREAMER })

    const res = await collectionsPatch(
      makePatchRequest({ streamerId: 'streamer-1', oldName: 'weapons', newName: 'armory' })
    )

    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('rename_card_pack', {
      p_streamer_id: 'streamer-1',
      p_old_name: 'weapons',
      p_new_name: 'armory',
    })
    expect(getDb).not.toHaveBeenCalled()
  })

  it('pg 経路 正常系: 名前付き引数(::uuid 明示キャスト)で呼ばれ、レスポンス形状が postgrest 経路と一致する', async () => {
    vi.stubEnv('DB_DRIVER', 'pg')
    const rpc = vi.fn()
    mockAdminForPatch({ streamer: CATALOG_STREAMER, rpc })
    const sqlMock = createSqlMock([{ rows: [] }])
    primePgDb(sqlMock)

    const res = await collectionsPatch(
      makePatchRequest({ streamerId: 'streamer-1', oldName: 'weapons', newName: '  armory  ' })
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ success: true, cardPackNames: ['armory', 'characters'] })

    expect(sqlMock).toHaveBeenCalledTimes(1)
    const { text, values } = renderSqlCall(sqlMock, 0)
    expect(text).toContain('rename_card_pack')
    expect(text).toContain('p_streamer_id => $::uuid')
    expect(text).toContain('p_old_name => $')
    expect(text).toContain('p_new_name => $')
    expect(values).toEqual(['streamer-1', 'weapons', 'armory'])
    expect(rpc).not.toHaveBeenCalled()
  })

  it('pg 経路 42883 (RPC未デプロイ): 既存と同じ 503 (PACK_RENAME_NOT_READY) を返す', async () => {
    vi.stubEnv('DB_DRIVER', 'pg')
    mockAdminForPatch({ streamer: CATALOG_STREAMER })
    const sqlMock = createSqlMock([
      { reject: pgError('42883', 'function rename_card_pack(uuid, text, text) does not exist') },
    ])
    primePgDb(sqlMock)

    const res = await collectionsPatch(
      makePatchRequest({ streamerId: 'streamer-1', oldName: 'weapons', newName: 'armory' })
    )

    expect(res.status).toBe(503)
  })

  it('pg 経路 レース由来の RAISE EXCEPTION (OLD_NAME_NOT_FOUND): 既存と同じ 400 を返す', async () => {
    // ルートの事前チェックを通過した後、RPC 実行までの間に並行編集が割り込んだ
    // レースを模す(cards-collections-route.test.ts の既存 postgrest テストと同種)。
    vi.stubEnv('DB_DRIVER', 'pg')
    mockAdminForPatch({ streamer: CATALOG_STREAMER })
    const sqlMock = createSqlMock([{ reject: pgError('P0001', 'OLD_NAME_NOT_FOUND') }])
    primePgDb(sqlMock)

    const res = await collectionsPatch(
      makePatchRequest({ streamerId: 'streamer-1', oldName: 'weapons', newName: 'armory' })
    )

    expect(res.status).toBe(400)
  })

  it('非冪等: CONNECTION_CLOSED でもリトライされず(1回のみ実行)、既存と同じ 500 を返す', async () => {
    vi.stubEnv('DB_DRIVER', 'pg')
    mockAdminForPatch({ streamer: CATALOG_STREAMER })
    // 2回目の応答を成功にしておき、「リトライされていれば成功していた」状況でも
    // 1回で打ち切られること(=非冪等 RPC を安全側で扱えていること)を証明する
    const sqlMock = createSqlMock([
      { reject: pgError('CONNECTION_CLOSED', 'write CONNECTION_CLOSED') },
      { rows: [] },
    ])
    primePgDb(sqlMock)

    const res = await collectionsPatch(
      makePatchRequest({ streamerId: 'streamer-1', oldName: 'weapons', newName: 'armory' })
    )

    expect(res.status).toBe(500)
    expect(sqlMock).toHaveBeenCalledTimes(1)
  })
})

// =============================================================================
// 3. activate_support_code
// =============================================================================

describe('activate_support_code (#573)', () => {
  function createActivateRequest(body: Record<string, unknown> = { code: 'test-code-123' }): NextRequest {
    return new NextRequest('http://localhost:3000/api/support/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  function mockAdminForActivate(rpc?: ReturnType<typeof vi.fn>) {
    mockGetSupabaseAdmin.mockReturnValue({ rpc: rpc ?? vi.fn() } as unknown as ReturnType<typeof getSupabaseAdmin>)
  }

  it('postgrest 経路(フラグ未設定): 既存 supabase-js RPC で実行され getDb は呼ばれない', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { success: true, plan_type: 'support' }, error: null })
    mockAdminForActivate(rpc)

    const response = await activatePost(createActivateRequest())

    expect(response.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('activate_support_code', {
      p_code_hash: 'hashed-code-value',
      p_twitch_user_id: 'twitch-user-123',
      p_fanbox_id: null,
    })
    expect(getDb).not.toHaveBeenCalled()
  })

  it('pg 経路 正常系: 名前付き引数(text は無キャスト)で呼ばれ、レスポンス形状が postgrest 経路と一致する', async () => {
    vi.stubEnv('DB_DRIVER', 'pg')
    const rpc = vi.fn()
    mockAdminForActivate(rpc)
    const sqlMock = createSqlMock([{ rows: [{ result: { success: true, plan_type: 'patron' } }] }])
    primePgDb(sqlMock)

    const response = await activatePost(createActivateRequest({ code: 'test-code', fanboxId: 'my-fanbox-id' }))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ success: true, planType: 'patron' })

    expect(sqlMock).toHaveBeenCalledTimes(1)
    const { text, values } = renderSqlCall(sqlMock, 0)
    expect(text).toContain('activate_support_code')
    expect(text).toContain('p_code_hash => $')
    expect(text).toContain('p_twitch_user_id => $')
    expect(text).toContain('p_fanbox_id => $')
    expect(values).toEqual(['hashed-code-value', 'twitch-user-123', 'my-fanbox-id'])
    expect(rpc).not.toHaveBeenCalled()
  })

  it('pg 経路: RPC が返す ALREADY_ACTIVATED エラーは既存と同じ 409 にマッピングされる', async () => {
    vi.stubEnv('DB_DRIVER', 'pg')
    mockAdminForActivate()
    const sqlMock = createSqlMock([{ rows: [{ result: { error: 'ALREADY_ACTIVATED' } }] }])
    primePgDb(sqlMock)

    const response = await activatePost(createActivateRequest())

    expect(response.status).toBe(409)
  })

  it('非冪等: CONNECTION_CLOSED でもリトライされず(1回のみ実行)、既存と同じ 500 を返す', async () => {
    vi.stubEnv('DB_DRIVER', 'pg')
    mockAdminForActivate()
    // 2回目の応答を成功にしておき、リトライされていれば成功していた状況でも
    // 1回で打ち切られること(activation_count 二重加算・成功の見かけ失敗化を防ぐ)を証明する
    const sqlMock = createSqlMock([
      { reject: pgError('CONNECTION_CLOSED', 'write CONNECTION_CLOSED') },
      { rows: [{ result: { success: true, plan_type: 'support' } }] },
    ])
    primePgDb(sqlMock)

    const response = await activatePost(createActivateRequest())

    expect(response.status).toBe(500)
    expect(sqlMock).toHaveBeenCalledTimes(1)
  })
})

// =============================================================================
// 4. deactivate_all_licenses
// =============================================================================

describe('deactivate_all_licenses (#573)', () => {
  function createDeactivateRequest(): NextRequest {
    return new NextRequest('http://localhost:3000/api/support/deactivate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
  }

  function mockAdminForDeactivate(rpc?: ReturnType<typeof vi.fn>) {
    mockGetSupabaseAdmin.mockReturnValue({ rpc: rpc ?? vi.fn() } as unknown as ReturnType<typeof getSupabaseAdmin>)
  }

  it('postgrest 経路(フラグ未設定): 既存 supabase-js RPC で実行され getDb は呼ばれない', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { success: true, deleted_count: 2 }, error: null })
    mockAdminForDeactivate(rpc)

    const response = await deactivatePost(createDeactivateRequest())

    expect(response.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('deactivate_all_licenses', { p_twitch_user_id: 'twitch-user-123' })
    expect(getDb).not.toHaveBeenCalled()
  })

  it('pg 経路 正常系: 名前付き引数(text は無キャスト)で呼ばれ、レスポンス形状が postgrest 経路と一致する', async () => {
    vi.stubEnv('DB_DRIVER', 'pg')
    const rpc = vi.fn()
    mockAdminForDeactivate(rpc)
    const sqlMock = createSqlMock([{ rows: [{ result: { success: true, deleted_count: 1 } }] }])
    primePgDb(sqlMock)

    const response = await deactivatePost(createDeactivateRequest())

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ success: true, planType: 'basic' })

    expect(sqlMock).toHaveBeenCalledTimes(1)
    const { text, values } = renderSqlCall(sqlMock, 0)
    expect(text).toContain('deactivate_all_licenses')
    expect(text).toContain('p_twitch_user_id => $')
    expect(values).toEqual(['twitch-user-123'])
    expect(rpc).not.toHaveBeenCalled()
  })

  it('冪等リトライ: CONNECTION_CLOSED 後にリトライして成功する(idempotent:true — DELETEは空集合に収束するため)', async () => {
    vi.stubEnv('DB_DRIVER', 'pg')
    mockAdminForDeactivate()
    const sqlMock = createSqlMock([
      { reject: pgError('CONNECTION_CLOSED', 'write CONNECTION_CLOSED') },
      { rows: [{ result: { success: true, deleted_count: 0 } }] },
    ])
    primePgDb(sqlMock)

    const response = await deactivatePost(createDeactivateRequest())

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ success: true, planType: 'basic' })
    expect(sqlMock).toHaveBeenCalledTimes(2)
  })

  it('pg 経路で RPC エラー: 既存と同じ 500 (handleApiError) を返す', async () => {
    vi.stubEnv('DB_DRIVER', 'pg')
    mockAdminForDeactivate()
    const sqlMock = createSqlMock([{ reject: pgError('XX000', 'unexpected database error') }])
    primePgDb(sqlMock)

    const response = await deactivatePost(createDeactivateRequest())

    expect(response.status).toBe(500)
  })
})
