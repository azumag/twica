/**
 * #663: /api/announcements/read (POST) の postgrest 経路 / pg 経路の互換テスト
 *
 * tests/unit/tos-accept-driver-parity.test.ts / support-inquiries-api-driver-parity.test.ts
 * と同じ流儀。announcement_reads への書き込み（UPSERT 相当）を含むため
 * isPgWriteEnabled() で分岐する（DB_DRIVER=pg のときのみ pg 経路、pg-read では
 * postgrest 経路のまま）。CSRF / セッション / レートリミット / バリデーションの
 * ガード節はフラグに依らず同一に効くことも合わせて検証する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/announcements/read/route'
import { getSession } from '@/lib/session'
import { validateCSRFToken } from '@/lib/csrf'
import { checkRateLimit } from '@/lib/rate-limit'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getDb } from '@/lib/db/client'
import { announcementReads as announcementReadsTable } from '@/lib/db/schema'

vi.mock('@/lib/session')
vi.mock('@/lib/csrf')
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(),
  rateLimits: { announcementRead: {} },
  getRateLimitIdentifier: vi.fn().mockResolvedValue('user:user-1'),
}))

const mockGetSession = vi.mocked(getSession)
const mockValidateCSRFToken = vi.mocked(validateCSRFToken)
const mockCheckRateLimit = vi.mocked(checkRateLimit)

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'

function createRequest(body: unknown = { announcementId: VALID_UUID }): NextRequest {
  return new NextRequest('http://localhost:3000/api/announcements/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ---------------------------------------------------------------------------
// postgrest 経路のモック: from('announcement_reads').upsert(values, options)
// ---------------------------------------------------------------------------

function createSupabaseClientMock(options: { error?: unknown } = {}) {
  const upsertCalls: Array<{ values: unknown; options: unknown }> = []
  const from = vi.fn(() => ({
    upsert: vi.fn((values: unknown, opts: unknown) => {
      upsertCalls.push({ values, options: opts })
      return Promise.resolve({ error: options.error ?? null })
    }),
  }))
  return { from, upsertCalls }
}

// ---------------------------------------------------------------------------
// pg 経路のモック: db.insert(table).values(...).onConflictDoNothing({ target })
// ---------------------------------------------------------------------------

interface PgInsertCall {
  table: unknown
  values?: Record<string, unknown>
  target?: unknown
}

function createDrizzleDbMock(options: { error?: unknown } = {}) {
  const insertCalls: PgInsertCall[] = []
  const db = {
    insert: vi.fn((table: unknown) => {
      const call: PgInsertCall = { table }
      insertCalls.push(call)
      const builder: any = {
        values: vi.fn((values: Record<string, unknown>) => {
          call.values = values
          return builder
        }),
        onConflictDoNothing: vi.fn((opts: { target?: unknown }) => {
          call.target = opts?.target
          return options.error ? Promise.reject(options.error) : Promise.resolve([])
        }),
      }
      return builder
    }),
  }
  return { db, insertCalls }
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any)
}

function allowRateLimit() {
  mockCheckRateLimit.mockResolvedValue({
    success: true,
    limit: 20,
    remaining: 19,
    reset: Date.now() + 60000,
  })
}

describe('/api/announcements/read: postgrest / pg 経路の互換 (#663)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    allowRateLimit()
    mockValidateCSRFToken.mockResolvedValue({ valid: true })
    mockGetSession.mockResolvedValue({
      twitchUserId: 'user-1',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: null,
      broadcasterType: '',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: 1,
    } as any)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('成功時: 両経路とも 200 + { success: true } を返し、INSERT の values/conflict target が一致する', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock()
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestRes = await POST(createRequest())
    const postgrestBody = await postgrestRes.json()

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock()
    primePgDb(pg)
    const pgRes = await POST(createRequest())
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)
    expect(pgBody).toEqual({ success: true })

    // ON CONFLICT DO NOTHING（既存の upsert(onConflict: 'announcement_id,twitch_user_id')
    // と最終状態が等価であることの根拠は route.ts のコメント参照）の values/target パリティ
    expect(pg.insertCalls).toHaveLength(1)
    expect(pg.insertCalls[0].table).toBe(announcementReadsTable)
    expect(pg.insertCalls[0].values).toEqual({
      announcement_id: VALID_UUID,
      twitch_user_id: 'user-1',
    })
    expect(pg.insertCalls[0].values).toEqual(client.upsertCalls[0].values)
    expect(pg.insertCalls[0].target).toEqual([
      announcementReadsTable.announcement_id,
      announcementReadsTable.twitch_user_id,
    ])
  })

  it('書き込み失敗時: 両経路とも 500 + 同一 body を返す', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({ error: { message: 'boom' } })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestRes = await POST(createRequest())

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({ error: new Error('boom') })
    primePgDb(pg)
    const pgRes = await POST(createRequest())

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(500)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
  })

  it('CSRF 無効: 両経路とも 403（フラグに依らず同一。getDb は呼ばれない）', async () => {
    mockValidateCSRFToken.mockResolvedValue({ valid: false })
    for (const driver of [undefined, 'pg']) {
      vi.stubEnv('DB_DRIVER', driver as string)
      const res = await POST(createRequest())
      expect(res.status).toBe(403)
    }
    expect(getDb).not.toHaveBeenCalled()
  })

  it('未認証: 両経路とも 401', async () => {
    mockGetSession.mockResolvedValue(null)
    for (const driver of [undefined, 'pg']) {
      vi.stubEnv('DB_DRIVER', driver as string)
      const res = await POST(createRequest())
      expect(res.status).toBe(401)
    }
    expect(getDb).not.toHaveBeenCalled()
  })

  it('レート制限超過: 両経路とも 429', async () => {
    mockCheckRateLimit.mockResolvedValue({
      success: false,
      limit: 20,
      remaining: 0,
      reset: Date.now() + 60000,
    })
    for (const driver of [undefined, 'pg']) {
      vi.stubEnv('DB_DRIVER', driver as string)
      const res = await POST(createRequest())
      expect(res.status).toBe(429)
    }
  })

  it('不正な announcementId（UUID形式でない）: 両経路とも 400（DB アクセス前に弾かれる）', async () => {
    for (const driver of [undefined, 'pg']) {
      vi.stubEnv('DB_DRIVER', driver as string)
      const res = await POST(createRequest({ announcementId: 'not-a-uuid' }))
      expect(res.status).toBe(400)
    }
    expect(getDb).not.toHaveBeenCalled()
  })

  it('DB_DRIVER=pg-read では書き込みハンドラのため postgrest 経路のまま（getDb 不使用）', async () => {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const client = createSupabaseClientMock()
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)

    const res = await POST(createRequest())
    expect(res.status).toBe(200)
    expect(getDb).not.toHaveBeenCalled()
  })

  it('フラグ未設定時は getDb が一切呼ばれない（挙動不変の検証）', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock()
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)

    await POST(createRequest())
    expect(getDb).not.toHaveBeenCalled()
  })
})
