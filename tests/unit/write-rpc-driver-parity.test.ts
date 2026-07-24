/**
 * #573: PlanetScale書き込み系RPC 4件の回帰テスト
 *   1. batch_update_card_drop_rates (src/lib/recalculate-drop-rates.ts,
 *      src/app/api/cards/batch-update/route.ts)
 *   2. rename_card_pack (src/app/api/cards/collections/route.ts, PATCH)
 *   3. activate_support_code (src/app/api/support/activate/route.ts)
 *   4. deactivate_all_licenses (src/app/api/support/deactivate/route.ts)
 *
 * 各RPCについて以下を固定する（既存PlanetScale RPCテストと同じ観点。
 * tests/unit/gacha-rpc-driver-parity.test.ts / dashboard-data-rpc-driver-parity.test.ts
 * / storage-db-driver-parity.test.ts の流儀を踏襲）:
 *   1. 名前付き引数と必要な明示キャストを含むSQLが実行されること
 *   2. routeの所有権確認を含め、読み書きがPlanetScale内で完結すること
 *   3. 非冪等RPC（rename_card_pack / activate_support_code）は接続断でも
 *      リトライされず、冪等RPCは接続断後に安全にリトライされること
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
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
import { getDb } from '@/lib/db/client'

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

const mockGetSession = vi.mocked(getSession)
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures)
const mockCheckRateLimit = vi.mocked(checkRateLimit)
const mockGetRateLimitIdentifier = vi.mocked(getRateLimitIdentifier)
const mockValidateCSRFToken = vi.mocked(validateCSRFToken)
const mockValidateContentType = vi.mocked(validateContentType)

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

/**
 * Issue #794: pg経路でSELECTを含む処理向けの最小Drizzleモック。
 * responsesをSELECT呼び出し順に返し、from/where/limitのチェインを再現する。
 */
function primePgDbWithSelectResponses(
  sqlMock: ReturnType<typeof createSqlMock>,
  responses: unknown[][]
) {
  let callIndex = 0
  const select = vi.fn(() => {
    const rows = responses[Math.min(callIndex, responses.length - 1)] ?? []
    callIndex += 1
    const builder: Record<string, unknown> = {}
    builder.from = vi.fn(() => builder)
    builder.where = vi.fn(() => builder)
    builder.limit = vi.fn(() => builder)
    builder.then = (
      resolve: (value: unknown[]) => unknown,
      reject: (reason: unknown) => unknown
    ) => Promise.resolve(rows).then(resolve, reject)
    return builder
  })
  vi.mocked(getDb).mockResolvedValue({
    db: { select } as never,
    sql: sqlMock as never,
  })
  return select
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

// =============================================================================
// 1. batch_update_card_drop_rates
// =============================================================================

describe('batch_update_card_drop_rates PlanetScale契約 (#573)', () => {
  describe('executeBatchUpdateCardDropRatesRpcPg (共有PlanetScale実装)', () => {
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

  describe('recalculateIfAutoMode (PlanetScale)', () => {
    const RARITY_WEIGHTS = { common: 100 }
    const ACTIVE_CARDS = [{ id: 'card-1', rarity: 'common', is_active: true, intra_rarity_weight: 1 }]
    const RECALCULATED_CARDS = [{ id: 'card-1', streamer_id: 'streamer-1', drop_rate: 1, rarity: 'common' }]

    it('PlanetScale経路: executeBatchUpdateCardDropRatesRpcPgで更新する', async () => {
      const sqlMock = createSqlMock([{ rows: [{ result: { updated_count: 1 } }] }])
      const selectMock = primePgDbWithSelectResponses(sqlMock, [ACTIVE_CARDS, RECALCULATED_CARDS])

      const result = await recalculateIfAutoMode('streamer-1', RARITY_WEIGHTS)

      expect(result).toEqual(RECALCULATED_CARDS)
      expect(selectMock).toHaveBeenCalledTimes(2)
      expect(sqlMock).toHaveBeenCalledTimes(1)
      const { values } = renderSqlCall(sqlMock, 0)
      expect(values).toEqual(['streamer-1', JSON.stringify([{ id: 'card-1', drop_rate: 1 }])])
    })
  })

  describe('POST /api/cards/batch-update (PlanetScale)', () => {
    function createRequest(body: Record<string, unknown>): NextRequest {
      return new NextRequest('http://localhost:3000/api/cards/batch-update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    }

    it('正常系: 所有権確認・対象確認・更新・再取得がPlanetScale内で完結する', async () => {
      const sqlMock = createSqlMock([{ rows: [{ result: { updated_count: 1 } }] }])
      const selectMock = primePgDbWithSelectResponses(sqlMock, [
        [{ id: 'streamer-1', rarity_weights: null }],
        [{ id: 'card-1' }],
        [{ id: 'card-1', drop_rate: 0.5 }],
      ])

      const response = await batchUpdatePost(
        createRequest({ streamerId: 'streamer-1', updates: [{ id: 'card-1', dropRate: 0.5 }] })
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toMatchObject({ success: true, updated: 1 })
      expect(selectMock).toHaveBeenCalledTimes(3)
      expect(sqlMock).toHaveBeenCalledTimes(1)
      const { text } = renderSqlCall(sqlMock, 0)
      expect(text).toContain('batch_update_card_drop_rates')
    })

    it('RPCエラーは500 (handleDatabaseError) を返す', async () => {
      const sqlMock = createSqlMock([{ reject: pgError('XX000', 'unexpected database error') }])
      const selectMock = primePgDbWithSelectResponses(sqlMock, [
        [{ id: 'streamer-1', rarity_weights: null }],
        [{ id: 'card-1' }],
      ])

      const response = await batchUpdatePost(
        createRequest({ streamerId: 'streamer-1', updates: [{ id: 'card-1', dropRate: 0.5 }] })
      )

      expect(response.status).toBe(500)
      expect(selectMock).toHaveBeenCalledTimes(2)
    })
  })
})

// =============================================================================
// 2. rename_card_pack
// =============================================================================

describe('rename_card_pack PlanetScale契約 (#573)', () => {
  function makePatchRequest(body: unknown) {
    return new NextRequest('http://localhost/api/cards/collections', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  const CATALOG_STREAMER = { id: 'streamer-1', card_pack_names: ['weapons', 'characters'] }

  /**
   * PATCHはRPC前に同じPlanetScale接続上でstreamer所有権とpack catalogを読む。
   * ここを省略するとrouteはDB取得失敗を安全側の403へ変換するため、各RPC契約
   * テストでも認可前提を実データ形状で満たしてからSQL結果を検証する。
   */
  function primeRenameDb(sqlMock: ReturnType<typeof createSqlMock>) {
    return primePgDbWithSelectResponses(sqlMock, [[CATALOG_STREAMER]])
  }

  it('正常系: 所有権確認後、名前付き引数(::uuid 明示キャスト)で呼ばれる', async () => {
    const sqlMock = createSqlMock([{ rows: [] }])
    const selectMock = primeRenameDb(sqlMock)

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
    expect(selectMock).toHaveBeenCalledTimes(1)
  })

  it('42883 (RPC未デプロイ) は503 (PACK_RENAME_NOT_READY) を返す', async () => {
    const sqlMock = createSqlMock([
      { reject: pgError('42883', 'function rename_card_pack(uuid, text, text) does not exist') },
    ])
    primeRenameDb(sqlMock)

    const res = await collectionsPatch(
      makePatchRequest({ streamerId: 'streamer-1', oldName: 'weapons', newName: 'armory' })
    )

    expect(res.status).toBe(503)
  })

  it('レース由来のRAISE EXCEPTION (OLD_NAME_NOT_FOUND) は400を返す', async () => {
    // ルートの事前チェックを通過した後、RPC 実行までの間に並行編集が割り込んだ
    // レースを模す（所有権・catalogの事前SELECTは成功させる）。
    const sqlMock = createSqlMock([{ reject: pgError('P0001', 'OLD_NAME_NOT_FOUND') }])
    primeRenameDb(sqlMock)

    const res = await collectionsPatch(
      makePatchRequest({ streamerId: 'streamer-1', oldName: 'weapons', newName: 'armory' })
    )

    expect(res.status).toBe(400)
  })

  it('非冪等: CONNECTION_CLOSEDでもリトライされず1回のみ実行して500を返す', async () => {
    // 2回目の応答を成功にしておき、「リトライされていれば成功していた」状況でも
    // 1回で打ち切られること(=非冪等 RPC を安全側で扱えていること)を証明する
    const sqlMock = createSqlMock([
      { reject: pgError('CONNECTION_CLOSED', 'write CONNECTION_CLOSED') },
      { rows: [] },
    ])
    primeRenameDb(sqlMock)

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

describe('activate_support_code PlanetScale契約 (#573)', () => {
  function createActivateRequest(body: Record<string, unknown> = { code: 'test-code-123' }): NextRequest {
    return new NextRequest('http://localhost:3000/api/support/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('正常系: 名前付き引数（textは無キャスト）で呼ばれる', async () => {
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
  })

  it('RPCが返すALREADY_ACTIVATEDエラーは409にマッピングされる', async () => {
    const sqlMock = createSqlMock([{ rows: [{ result: { error: 'ALREADY_ACTIVATED' } }] }])
    primePgDb(sqlMock)

    const response = await activatePost(createActivateRequest())

    expect(response.status).toBe(409)
  })

  it('非冪等: CONNECTION_CLOSEDでもリトライされず1回のみ実行して500を返す', async () => {
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

describe('deactivate_all_licenses PlanetScale契約 (#573)', () => {
  function createDeactivateRequest(): NextRequest {
    return new NextRequest('http://localhost:3000/api/support/deactivate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
  }

  it('正常系: 名前付き引数（textは無キャスト）で呼ばれる', async () => {
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
  })

  it('冪等リトライ: CONNECTION_CLOSED 後にリトライして成功する(idempotent:true — DELETEは空集合に収束するため)', async () => {
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

  it('RPCエラーは500 (handleApiError) を返す', async () => {
    const sqlMock = createSqlMock([{ reject: pgError('XX000', 'unexpected database error') }])
    primePgDb(sqlMock)

    const response = await deactivatePost(createDeactivateRequest())

    expect(response.status).toBe(500)
  })
})
