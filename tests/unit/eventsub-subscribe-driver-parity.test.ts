/**
 * Issue #690 (#570 パイロット踏襲): EventSub subscribe API の「streamer 存在確認」
 * クエリについて、postgrest 経路 / pg 経路の応答互換性を検証する。
 *
 * 厳格レビュー指摘 (minor-1) により、streamer 存在確認クエリ（postgrest/pg 分岐を
 * 含む実装本体）は route.ts から src/lib/user-data.ts の
 * getStreamerIdByTwitchUserId() に統合された（dashboard/history ページの実装 #711
 * と完全に同一クエリだった重複の解消）。route.ts は素通しでこのヘルパーを呼ぶだけに
 * なったため、本ファイルは「route.ts がヘルパーの戻り値をどう扱うか（見つかれば
 * 後続処理へ、見つからなければ 404）」を検証する。ヘルパー自体の postgrest/pg
 * 分岐・エラー写像の詳細な網羅テストは tests/unit/user-data-driver-parity.test.ts
 * （getStreamerIdByTwitchUserId の describe ブロック）が担当する。ここでは
 * `@/lib/db/client` の getDb を直接モックして「route.ts 経由でもヘルパー内部の
 * pg 直結クエリが同じ形で発火する」ところまでは重複して検証し（呼び出し配線の
 * 取り違えを検知するため）、エラー分類の網羅性はユニットテストの重複を避けるため
 * user-data-driver-parity.test.ts に委ねる。
 *
 * このファイルは「streamer 存在確認クエリ」に焦点を絞る（EventSub 登録の残り部分
 * ―Twitch API 呼び出しの詳細―は tests/unit/eventsub-subscribe-csrf.test.ts が
 * 別途カバー済みで、DB ドライバに依存しないためここでは再検証しない）。
 * 検証観点:
 *   1. streamer が見つかった場合: 両経路とも 404 にならず後続処理（Twitch API 呼び出し）
 *      へ進む（＝ streamer 未検出扱いになっていないこと）
 *   2. streamer が見つからない場合: 両経路とも 404 + ERROR_MESSAGES.STREAMER_NOT_FOUND
 *   3. フラグ未設定（postgrest）では getDb が一切呼ばれない／pg 経路では
 *      supabase-js クライアントが一切呼ばれない（経路分離の検証）
 *   4. pg クエリが where(eq(streamers.twitch_user_id, ...)).limit(1) を
 *      正しい実引数で呼び出す（token-manager-driver-parity.test.ts 等と同じ
 *      構造比較パターン）
 *   5. 【既存バグの意図的再現の固定化】DB エラー時: postgrest 版の既存実装は
 *      `{ data: streamer }` のみを分割代入し `error` を一切見ないため、一時的な
 *      DB 障害が起きても data=null → 404(STREAMER_NOT_FOUND)という誤ったレスポンスに
 *      なる(既存実装由来の潜在バグ)。Phase 1 のパリティ原則(呼び出し側は経路を
 *      意識しない＝外部挙動の完全パリティ。バグ修正は別 Issue で postgrest/pg
 *      両経路同時に行う)に従い、pg 版(getStreamerIdByTwitchUserId)も例外を
 *      logger.error に記録した上で null を返し、同じ 404 になるよう
 *      **意図的に再現** している (src/lib/user-data.ts の getStreamerIdByTwitchUserId
 *      の JSDoc 参照。tos/accept の「行なし→accepted:true」再現等、他ルートの
 *      同種判断とも整合)。この再現が今後のリグレッションで 500 等に変わらないよう
 *      固定するテストを含む（このファイルでは route.ts 経由の外部挙動として固定し、
 *      ヘルパー単体でのエラー分類の網羅は user-data-driver-parity.test.ts が担う）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { POST } from '@/app/api/twitch/eventsub/subscribe/route'
import { validateCSRFToken } from '@/lib/csrf'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { checkRateLimit, getRateLimitIdentifier } from '@/lib/rate-limit'
import { ERROR_MESSAGES } from '@/lib/constants'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getDb } from '@/lib/db/client'
import { streamers as streamersTable } from '@/lib/db/schema'

vi.mock('@/lib/csrf')
vi.mock('@/lib/session')
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(),
  getRateLimitIdentifier: vi.fn(),
  rateLimits: { eventsubSubscribePost: {}, eventsubSubscribeGet: {} },
}))
vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
// handleApiError → logAndRecordError → logErrorFromLogger は既定で
// getSupabaseAdmin() 経由の "errors" テーブル書き込みを行う（DB_DRIVER 移行とは
// 無関係な既存のエラーロギング基盤）。ここではその副作用による
// getSupabaseAdmin 呼び出しを排除し、「streamer 存在確認クエリ」のドライバ分岐
// だけを純粋に検証できるようにする（overlay-events-api-pg.test.ts と同じ対処）。
vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn(),
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}))

const mockValidateCSRFToken = vi.mocked(validateCSRFToken)
const mockGetSession = vi.mocked(getSession)
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures)
const mockCheckRateLimit = vi.mocked(checkRateLimit)
const mockGetRateLimitIdentifier = vi.mocked(getRateLimitIdentifier)
const mockGetSupabaseAdmin = vi.mocked(getSupabaseAdmin)

const TWITCH_USER_ID = '123456789'

function createPostRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/twitch/eventsub/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rewardId: 'reward-123' }),
  })
}

// ---------------------------------------------------------------------------
// postgrest 経路のモック: from("streamers").select().eq().maybeSingle()
// ---------------------------------------------------------------------------
function createStreamerSupabaseMock(result: { data: unknown; error: null }) {
  const builder: any = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
  }
  const from = vi.fn((table: string) => {
    if (table !== 'streamers') {
      throw new Error(`Unexpected table: ${table}`)
    }
    return builder
  })
  return { from, builder }
}

// ---------------------------------------------------------------------------
// pg 経路のモック: db.select(fields).from(table).where(cond).limit(1)
// ---------------------------------------------------------------------------
interface DrizzleCallRecord {
  table: unknown
  whereCondition?: unknown
  limitValue?: number
}

function createDrizzleStreamerDbMock(rows: Array<{ id: string }>) {
  const calls: DrizzleCallRecord[] = []
  const select = vi.fn((fields: Record<string, unknown>) => ({
    from: vi.fn((table: unknown) => {
      const call: DrizzleCallRecord = { table }
      calls.push(call)
      const builder: any = {
        where: vi.fn((condition: unknown) => {
          call.whereCondition = condition
          return builder
        }),
        limit: vi.fn((n: number) => {
          call.limitValue = n
          const projected = rows.map((row) =>
            Object.fromEntries(Object.keys(fields).map((key) => [key, (row as Record<string, unknown>)[key]]))
          )
          return Promise.resolve(projected)
        }),
      }
      return builder
    }),
  }))
  return { select, calls }
}

/** streamers クエリが例外を throw するケース用の pg 経路モック(接続断等の恒久的エラー再現) */
function createDrizzleStreamerErrorDbMock(error: unknown) {
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(() => Promise.reject(error)),
      })),
    })),
  }))
  return { select }
}

describe('POST /api/twitch/eventsub/subscribe: streamer 存在確認クエリの postgrest / pg 経路互換 (#690)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_TWITCH_CLIENT_ID = 'client-id'
    process.env.TWITCH_CLIENT_SECRET = 'client-secret'
    process.env.TWITCH_EVENTSUB_SECRET = 'eventsub-secret'
    process.env.NEXT_PUBLIC_APP_URL = 'https://twica.example'

    mockValidateCSRFToken.mockResolvedValue({ valid: true })
    mockGetSession.mockResolvedValue({
      twitchUserId: TWITCH_USER_ID,
      twitchUsername: 'streamer',
      twitchDisplayName: 'Streamer',
      twitchProfileImageUrl: 'https://example.com/avatar.png',
      broadcasterType: 'affiliate',
      expiresAt: Date.now() + 60_000,
      version: 1,
    } as any)
    mockCanUseStreamerFeatures.mockReturnValue(true)
    mockGetRateLimitIdentifier.mockResolvedValue('user:' + TWITCH_USER_ID)
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Date.now() + 60_000,
    })
  })

  afterEach(() => {
    // db-flags.test.ts 等と同じ変数を扱うため、他テストへ漏れないよう必ず復元する
    vi.unstubAllEnvs()
  })

  // 注意: fetchMock は各テスト側で assertion 後に mockRestore() すること。
  // ここで restore すると .mock.calls の呼び出し履歴も一緒にクリアされてしまい
  // (vitest の mockRestore は mockReset を兼ねる)、戻り値の fetchMock を使った
  // 呼び出し検証ができなくなる。
  async function runPostgrestPath(streamerRow: { id: string } | null) {
    vi.stubEnv('DB_DRIVER', undefined)
    const supabase = createStreamerSupabaseMock({ data: streamerRow, error: null })
    mockGetSupabaseAdmin.mockReturnValue(supabase as any)
    // streamer が見つかった場合に到達する後続 Twitch API 呼び出しはドライバ非依存
    // (tests/unit/eventsub-subscribe-csrf.test.ts で別途検証済み) なので、ここでは
    // getAppAccessToken 呼び出しに到達したかどうかだけを fetch モックの呼び出し
    // 有無で確認できれば十分。トークン取得自体は失敗させ、後続処理を簡潔に打ち切る。
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'token error' }), { status: 500 })
    )
    const response = await POST(createPostRequest())
    const body = await response.json()
    return { response, body, supabase, fetchMock }
  }

  async function runPgPath(streamerRows: Array<{ id: string }>) {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const db = createDrizzleStreamerDbMock(streamerRows)
    vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'token error' }), { status: 500 })
    )
    const response = await POST(createPostRequest())
    const body = await response.json()
    return { response, body, db, fetchMock }
  }

  it('streamer が見つかった場合: 両経路とも404にならず後続のTwitch API呼び出しへ進む', async () => {
    const { response: postgrestRes, fetchMock: postgrestFetch } = await runPostgrestPath({ id: 'streamer-db-1' })
    const { response: pgRes, fetchMock: pgFetch } = await runPgPath([{ id: 'streamer-db-1' }])

    // どちらも streamer 未検出の404にはならない(後段のgetAppAccessToken失敗により
    // 500になる。tests/unit/eventsub-subscribe-csrf.test.ts が正常系の200を別途検証)
    expect(postgrestRes.status).not.toBe(404)
    expect(pgRes.status).not.toBe(404)
    expect(postgrestRes.status).toBe(pgRes.status)
    // 後続のgetAppAccessToken(Twitch OAuth token endpoint)まで到達している
    expect(postgrestFetch).toHaveBeenCalledWith(
      'https://id.twitch.tv/oauth2/token',
      expect.objectContaining({ method: 'POST' })
    )
    expect(pgFetch).toHaveBeenCalledWith(
      'https://id.twitch.tv/oauth2/token',
      expect.objectContaining({ method: 'POST' })
    )
    postgrestFetch.mockRestore()
    pgFetch.mockRestore()
  })

  it('streamer が見つからない場合: 両経路とも404 + STREAMER_NOT_FOUNDで完全一致する', async () => {
    const { response: postgrestRes, body: postgrestBody, fetchMock: postgrestFetch } = await runPostgrestPath(null)
    const { response: pgRes, body: pgBody, fetchMock: pgFetch } = await runPgPath([])

    expect(postgrestRes.status).toBe(404)
    expect(pgRes.status).toBe(404)
    expect(postgrestBody).toEqual({ error: ERROR_MESSAGES.STREAMER_NOT_FOUND })
    expect(pgBody).toEqual(postgrestBody)

    // 404で早期returnするため、Twitch APIへは一切到達しない(両経路とも)
    expect(postgrestFetch).not.toHaveBeenCalled()
    expect(pgFetch).not.toHaveBeenCalled()
    postgrestFetch.mockRestore()
    pgFetch.mockRestore()
  })

  it('postgrest 経路（フラグ未設定）では getDb が一切呼ばれない（挙動不変の検証）', async () => {
    const { fetchMock } = await runPostgrestPath({ id: 'streamer-db-1' })
    expect(getDb).not.toHaveBeenCalled()
    fetchMock.mockRestore()
  })

  it('pg 経路では supabase-js クライアントが一切呼ばれない', async () => {
    const { fetchMock } = await runPgPath([{ id: 'streamer-db-1' }])
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    fetchMock.mockRestore()
  })

  // 統括レビュー判断への対応(ファイル冒頭コメント5参照): DB 障害を
  // STREAMER_NOT_FOUND(404)にマスクするのは既存 postgrest 実装由来の潜在バグだが、
  // Phase 1 のパリティ原則に従い pg 経路でも意図的に再現する(統合先の
  // getStreamerIdByTwitchUserId(src/lib/user-data.ts) は例外を logger.error に
  // 記録して null を返す)。この「既存バグの意図的再現」が route.ts 経由の外部挙動
  // として今後のリグレッションで 500 等に変わらないよう固定する。
  it('pg 経路: streamers クエリが例外(DB障害等)を throw した場合も404 + STREAMER_NOT_FOUND(既存バグの意図的再現)になる', async () => {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    // 42601(syntax_error)は src/lib/db/retry.ts の RETRYABLE_SQLSTATES に含まれない
    // 恒久的エラーの例。withDbRetry がリトライせず1回で即 throw する。
    const db = createDrizzleStreamerErrorDbMock({ code: '42601', message: 'syntax error' })
    vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any)
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    const response = await POST(createPostRequest())
    const body = await response.json()

    // postgrest 経路(error 無視 → data null → 404)と同じ外部挙動
    expect(response.status).toBe(404)
    expect(body).toEqual({ error: ERROR_MESSAGES.STREAMER_NOT_FOUND })
    // 404で早期returnするため、後続のTwitch APIには到達しない
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockRestore()
  })

  it('pgクエリが streamers への where(twitch_user_id=...)・limit(1) を正しい実引数で呼び出す', async () => {
    const { db, fetchMock } = await runPgPath([{ id: 'streamer-db-1' }])

    expect(db.calls).toHaveLength(1)
    expect(db.calls[0].table).toBe(streamersTable)
    expect(db.calls[0].whereCondition).toEqual(eq(streamersTable.twitch_user_id, TWITCH_USER_ID))
    expect(db.calls[0].limitValue).toBe(1)
    fetchMock.mockRestore()
  })
})
