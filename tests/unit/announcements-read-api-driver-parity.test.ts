/**
 * #663/#708: POST /api/announcements/read のPlanetScale書き込みテスト
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/announcements/read/route'
import { getSession } from '@/lib/session'
import { validateCSRFToken } from '@/lib/csrf'
import { getDb } from '@/lib/db/client'
import { announcementReads as announcementReadsTable } from '@/lib/db/schema'

vi.mock('@/lib/session')
vi.mock('@/lib/csrf')
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ success: true, limit: 5, remaining: 4, reset: Date.now() + 60000 }),
  rateLimits: { announcementRead: {} },
  getRateLimitIdentifier: vi.fn().mockResolvedValue('user:user123'),
}))

const mockGetSession = vi.mocked(getSession)
const mockValidateCSRFToken = vi.mocked(validateCSRFToken)

const ANNOUNCEMENT_ID = '11111111-1111-4111-8111-111111111111'

function createRequest(announcementId: string | null = ANNOUNCEMENT_ID): NextRequest {
  return new NextRequest('http://localhost:3000/api/announcements/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ announcementId }),
  })
}

interface PgResponse {
  rows?: Array<Record<string, unknown>>
  error?: unknown
}

function createDrizzleDbMock(config: { inserts?: PgResponse[] } = {}) {
  let insertIndex = 0
  const insertCalls: Array<{ table: unknown; values?: Record<string, unknown>; conflictTarget?: unknown }> = []
  const db = {
    insert: vi.fn((table: unknown) => {
      const responses = config.inserts ?? [{ rows: [] }]
      const response = responses[Math.min(insertIndex, responses.length - 1)]
      insertIndex += 1
      const call: { table: unknown; values?: Record<string, unknown>; conflictTarget?: unknown } = { table }
      insertCalls.push(call)
      const resolve = () => (response.error ? Promise.reject(response.error) : Promise.resolve(response.rows ?? []))
      const builder: any = {
        values: vi.fn((values: Record<string, unknown>) => {
          call.values = values
          return builder
        }),
        onConflictDoNothing: vi.fn((opts: { target: unknown }) => {
          call.conflictTarget = opts.target
          return builder
        }),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
  }
  return { db, insertCalls }
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any)
}

describe('POST /api/announcements/read: PlanetScale経路 (#663/#708)', () => {
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
    mockValidateCSRFToken.mockResolvedValue({ valid: true } as any)
  })

  it('正しいテーブル/値でUPSERTされ、200を返す', async () => {
    const pg = createDrizzleDbMock()
    primePgDb(pg)

    const response = await POST(createRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ success: true })
    expect(pg.insertCalls[0].table).toBe(announcementReadsTable)
    expect(pg.insertCalls[0].values).toEqual({
      announcement_id: ANNOUNCEMENT_ID,
      twitch_user_id: 'user123',
    })
    expect(pg.insertCalls[0].conflictTarget).toEqual([
      announcementReadsTable.announcement_id,
      announcementReadsTable.twitch_user_id,
    ])
  })

  it('重複呼び出し（ON CONFLICT DO NOTHING）でもエラーにならず200を返す', async () => {
    const pg = createDrizzleDbMock({ inserts: [{ rows: [] }] })
    primePgDb(pg)

    const response = await POST(createRequest())
    expect(response.status).toBe(200)
  })

  it('DBエラー時は500を返す', async () => {
    const pg = createDrizzleDbMock({ inserts: [{ error: new Error('connection failure') }] })
    primePgDb(pg)

    const response = await POST(createRequest())
    expect(response.status).toBe(500)
  })

  it('不正なUUID形式では400を返す（DB未到達）', async () => {
    const response = await POST(createRequest('not-a-uuid'))
    expect(response.status).toBe(400)
    expect(getDb).not.toHaveBeenCalled()
  })
})
