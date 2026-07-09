/**
 * #663: 低頻度APIルート群のpg直結移行 — GET /api/user-cards の
 * postgrest経路 / pg経路パリティテスト
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '@/app/api/user-cards/route'
import { getSession } from '@/lib/session'
import { getDb } from '@/lib/db/client'

vi.mock('@/lib/session')
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ success: true, limit: 60, remaining: 59, reset: Date.now() + 60000 }),
  rateLimits: { cardsGet: {} },
  getRateLimitIdentifier: vi.fn().mockResolvedValue('user:user123'),
}))
vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn(),
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}))

const mockGetSession = vi.mocked(getSession)

function createRequest(): NextRequest {
  return new NextRequest('http://localhost/api/user-cards')
}

interface PgResponse {
  rows?: Array<Record<string, unknown>>
  error?: unknown
}

function createDrizzleDbMock(config: { selects?: PgResponse[] } = {}) {
  let selectIndex = 0
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
                Object.fromEntries(Object.keys(fields).map((key) => [key, row[key] ?? null]))
              )
            )
      const builder: any = {
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
  }
  return { db }
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any)
}

function createSupabaseMock(userResult: { data: unknown; error: unknown }, cardsResult: { data: unknown; error: unknown }) {
  return {
    from: vi.fn((table: string) => {
      if (table === 'users') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue(userResult) })) })) }
      }
      return { select: vi.fn(() => ({ eq: vi.fn(() => ({ range: vi.fn().mockResolvedValue(cardsResult) })) })) }
    }),
  }
}

describe('GET /api/user-cards: postgrest / pg 経路の互換 (#663)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSession.mockResolvedValue({
      twitchUserId: 'user123',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: '',
      broadcasterType: '',
      expiresAt: Date.now() + 60000,
      version: 1,
    } as any)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('フラグ未設定時は getDb が呼ばれない（挙動不変の検証）', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue(
      createSupabaseMock(
        { data: { id: 'user-uuid-1', twitch_user_id: 'user123' }, error: null },
        { data: [{ id: 'uc1', user_id: 'user-uuid-1', card_id: 'card1', obtained_at: '2026-01-01T00:00:00Z' }], error: null }
      ) as any
    )

    const response = await GET(createRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toHaveLength(1)
    expect(getDb).not.toHaveBeenCalled()
  })

  it('DB_DRIVER=pg-read: pg経路で正しいuser_idを条件にuser_cardsが取得される（postgrest経路と同じ結果）', async () => {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({
      selects: [
        { rows: [{ id: 'user-uuid-1', twitch_user_id: 'user123' }] },
        { rows: [{ id: 'uc1', user_id: 'user-uuid-1', card_id: 'card1', obtained_at: '2026-01-01T00:00:00Z' }] },
      ],
    })
    primePgDb(pg)

    const response = await GET(createRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(getDb).toHaveBeenCalled()
    expect(body).toEqual([
      { id: 'uc1', user_id: 'user-uuid-1', card_id: 'card1', obtained_at: '2026-01-01T00:00:00Z' },
    ])
  })

  it('DB_DRIVER=pg-read: ユーザーが見つからなければ500（handleDatabaseError、postgrest経路と同じ外部挙動）', async () => {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ selects: [{ rows: [] }] })
    primePgDb(pg)

    const response = await GET(createRequest())
    expect(response.status).toBe(500)
  })
})
