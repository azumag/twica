/**
 * #708: GET /api/user-cards のPostgres専用経路テスト。
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

describe('GET /api/user-cards: Postgres専用経路 (#708)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // tests/setup.ts は削除待ちの旧PostgREST parity fixture向けに互換opt-inを
    // 有効化する。このファイルは本番と同じ「フラグ未設定ならPostgres」という
    // 契約を検証するため、旧DB_DRIVER値を再導入せず互換sandbox自体を無効化する。
    vi.stubEnv('TWICA_ENABLE_LEGACY_SUPABASE', 'false')
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

  it('フラグなしでPostgresから正しいuser_idのuser_cardsを取得する', async () => {
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

  it('ユーザーが見つからなければhandleDatabaseErrorで500を返す', async () => {
    const pg = createDrizzleDbMock({ selects: [{ rows: [] }] })
    primePgDb(pg)

    const response = await GET(createRequest())
    expect(response.status).toBe(500)
  })
})
