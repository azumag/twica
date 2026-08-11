/**
 * Issue #690/#708: EventSub subscribe APIのstreamer存在確認をPlanetScaleで検証する。
 *
 * routeから共有helperへの配線、DrizzleのWHERE/LIMIT、0行時の404、DB障害時の
 * 既存エラー写像を固定する。Twitch APIとCSRFの詳細は専用テストが担当する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { POST } from '@/app/api/twitch/eventsub/subscribe/route'
import { validateCSRFToken } from '@/lib/csrf'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { checkRateLimit, getRateLimitIdentifier } from '@/lib/rate-limit'
import { ERROR_MESSAGES } from '@/lib/constants'
import { getDb } from '@/lib/db/client'
import { streamers as streamersTable } from '@/lib/db/schema'
import { __resetTwitchAppTokenForTests } from '@/lib/twitch/app-token'

vi.mock('@/lib/csrf')
vi.mock('@/lib/session')
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(),
  getRateLimitIdentifier: vi.fn(),
  rateLimits: { eventsubSubscribePost: {}, eventsubSubscribeGet: {} },
}))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
// エラー記録のDB副作用を切り離し、streamer存在確認クエリだけを検証する。
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
const TWITCH_USER_ID = '123456789'

function createPostRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/twitch/eventsub/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rewardId: 'reward-123' }),
  })
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

describe('POST /api/twitch/eventsub/subscribe: PlanetScaleのstreamer存在確認 (#690/#708)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetTwitchAppTokenForTests()
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

  // 注意: fetchMock は各テスト側で assertion 後に mockRestore() すること。
  // ここで restore すると .mock.calls の呼び出し履歴も一緒にクリアされてしまい
  // (vitest の mockRestore は mockReset を兼ねる)、戻り値の fetchMock を使った
  // 呼び出し検証ができなくなる。
  async function runPgPath(streamerRows: Array<{ id: string }>) {
    const db = createDrizzleStreamerDbMock(streamerRows)
    vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'token error' }), { status: 500 })
    )
    const response = await POST(createPostRequest())
    const body = await response.json()
    return { response, body, db, fetchMock }
  }

  it('streamerが見つかれば404にならず後続のTwitch APIへ進む', async () => {
    const { response: pgRes, fetchMock: pgFetch } = await runPgPath([{ id: 'streamer-db-1' }])

    expect(pgRes.status).not.toBe(404)
    // 後続のgetAppAccessToken(Twitch OAuth token endpoint)まで到達している
    expect(pgFetch).toHaveBeenCalledWith(
      'https://id.twitch.tv/oauth2/token',
      expect.objectContaining({ method: 'POST' })
    )
    pgFetch.mockRestore()
  })

  it('streamerが見つからなければ404 + STREAMER_NOT_FOUNDを返す', async () => {
    const { response: pgRes, body: pgBody, fetchMock: pgFetch } = await runPgPath([])

    expect(pgRes.status).toBe(404)
    expect(pgBody).toEqual({ error: ERROR_MESSAGES.STREAMER_NOT_FOUND })

    // 404で早期returnするため、Twitch APIへは一切到達しない(両経路とも)
    expect(pgFetch).not.toHaveBeenCalled()
    pgFetch.mockRestore()
  })

  it('streamer確認にPlanetScale接続を使う', async () => {
    const { fetchMock } = await runPgPath([{ id: 'streamer-db-1' }])
    expect(getDb).toHaveBeenCalled()
    fetchMock.mockRestore()
  })

  // 共有helperはDB例外をloggerへ記録してnullへ写像する。routeの現在の404契約が
  // 意図せず変わらないことを固定する。
  it('streamersクエリが例外をthrowした場合も404 + STREAMER_NOT_FOUNDになる', async () => {
    // 42601(syntax_error)は src/lib/db/retry.ts の RETRYABLE_SQLSTATES に含まれない
    // 恒久的エラーの例。withDbRetry がリトライせず1回で即 throw する。
    const db = createDrizzleStreamerErrorDbMock({ code: '42601', message: 'syntax error' })
    vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any)
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    const response = await POST(createPostRequest())
    const body = await response.json()

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
