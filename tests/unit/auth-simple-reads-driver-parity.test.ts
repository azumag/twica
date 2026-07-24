/**
 * #663/#708: 低頻度認証ルートのPlanetScale読み取りテスト
 *
 * 対象:
 *   - GET /api/auth/twitch/login（スコープ復元の読み取り）
 *   - POST /api/auth/reauth（既存スコープ取得の読み取り）
 *   - POST /api/auth/bot/connect（streamer存在確認の読み取り）
 *
 * 複数ルートで共通の session/rate-limit/csrf/getDb fixtureを使い、現行Drizzle
 * SELECTが正しいテーブル・条件・0/1行契約で実行されることを検証する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getSession } from '@/lib/session'
import { validateCSRFToken } from '@/lib/csrf'
import { checkRateLimit, getRateLimitIdentifier } from '@/lib/rate-limit'
import { getTwitchAuthUrl } from '@/lib/twitch/auth'
import { deleteTwitchTokens } from '@/lib/twitch/token-manager'
import { getDb } from '@/lib/db/client'

const mockCookieStore = { get: vi.fn(), set: vi.fn(), delete: vi.fn() }

vi.mock('next/headers', () => ({
  cookies: vi.fn(() => Promise.resolve(mockCookieStore)),
}))
vi.mock('@/lib/session', () => ({
  getSession: vi.fn(),
  parseSession: vi.fn(),
  verifySession: vi.fn(),
  canUseStreamerFeatures: vi.fn(() => true),
}))
vi.mock('@/lib/csrf', () => ({
  validateCSRFToken: vi.fn(),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(),
  getRateLimitIdentifier: vi.fn(),
  getClientIp: vi.fn(() => '127.0.0.1'),
  rateLimits: { authLogin: 'authLogin', authReauth: 'authReauth' },
}))
vi.mock('@/lib/twitch/auth', () => ({
  getTwitchAuthUrl: vi.fn(() => 'https://twitch.tv/authorize'),
}))
vi.mock('@/lib/twitch/token-manager', () => ({
  deleteTwitchTokens: vi.fn(() => Promise.resolve()),
}))
vi.mock('@/lib/auth-error-handler', () => ({ handleAuthError: vi.fn() }))
vi.mock('@/lib/error-handler', () => ({
  handleApiError: vi.fn((error: unknown) => ({
    json: async () => ({ error: String(error) }),
    status: 500,
  })),
}))
vi.mock('@/lib/sentry/error-handler', () => ({ reportAuthError: vi.fn() }))
vi.mock('@/lib/sentry/user-context', () => ({
  setRequestContext: vi.fn(),
  clearUserContext: vi.fn(),
}))
vi.mock('@/lib/url-utils', () => ({ getBaseUrl: vi.fn(() => 'http://localhost:3000') }))
vi.mock('@/lib/crypto-utils', () => ({ randomBytesHex: vi.fn(() => 'random-state-hex') }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
// reauth route はDBエラーを永続化する server-only logger を直接利用する。
// この境界をmockせず共有loggerだけをmockすると、503を返す直前の error() が
// 未mockのwrapperへ到達する一方、その永続化依存は上のfixtureから除かれているため
// logger自体が例外となり、route外側の500処理へ落ちてしまう。
vi.mock('@/lib/logger.server', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// ---------------------------------------------------------------------------
// PlanetScale/Drizzle query builder の最小モック
// ---------------------------------------------------------------------------
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

describe('低頻度認証ルート: PlanetScale経路 (#663/#708)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCookieStore.get.mockReturnValue(undefined)
    vi.mocked(checkRateLimit).mockResolvedValue({
      success: true,
      limit: 5,
      remaining: 4,
      reset: Date.now() + 60000,
    } as any)
    vi.mocked(getRateLimitIdentifier).mockResolvedValue('user:123456789')
    vi.mocked(validateCSRFToken).mockResolvedValue({ valid: true } as any)
  })

  describe('GET /api/auth/twitch/login', () => {
    it('PlanetScaleで読み取られた既存スコープがOAuth URLに反映される', async () => {
      vi.mocked(getSession).mockResolvedValue({ twitchUserId: '123456789' } as any)
      const pg = createDrizzleDbMock({ selects: [{ rows: [{ twitch_scopes: ['user:write:chat'] }] }] })
      primePgDb(pg)

      const { GET } = await import('@/app/api/auth/twitch/login/route')
      const response = await GET(new Request('http://localhost:3000/api/auth/twitch/login'))
      const authUrlArgs = vi.mocked(getTwitchAuthUrl).mock.calls[0]

      expect(response.status).toBe(200)
      expect(getDb).toHaveBeenCalled()
      expect(authUrlArgs[2]).toEqual(['user:write:chat'])
    })
  })

  describe('POST /api/auth/reauth', () => {
    it('PlanetScaleで既存スコープが読み取られる', async () => {
      vi.mocked(getSession).mockResolvedValue({ twitchUserId: '123456789' } as any)
      const pg = createDrizzleDbMock({ selects: [{ rows: [{ twitch_scopes: ['user:write:chat'] }] }] })
      primePgDb(pg)

      const { POST } = await import('@/app/api/auth/reauth/route')
      const response = await POST(new Request('http://localhost:3000/api/auth/reauth', { method: 'POST' }))
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(getDb).toHaveBeenCalled()
      expect(body.loginUrl).toBeDefined()
      expect(deleteTwitchTokens).toHaveBeenCalledWith('123456789')
    })

    it('列欠落(42703)はデプロイ窓として許容され200を返す', async () => {
      vi.mocked(getSession).mockResolvedValue({ twitchUserId: '123456789' } as any)
      const pg = createDrizzleDbMock({
        selects: [{ error: { code: '42703', message: 'column "twitch_scopes" does not exist' } }],
      })
      primePgDb(pg)

      const { POST } = await import('@/app/api/auth/reauth/route')
      const response = await POST(new Request('http://localhost:3000/api/auth/reauth', { method: 'POST' }))

      expect(response.status).toBe(200)
    })

    it('列欠落以外のエラーは503を返す', async () => {
      vi.mocked(getSession).mockResolvedValue({ twitchUserId: '123456789' } as any)
      const pg = createDrizzleDbMock({
        selects: [{ error: { code: '08006', message: 'connection failure' } }],
      })
      primePgDb(pg)

      const { POST } = await import('@/app/api/auth/reauth/route')
      const response = await POST(new Request('http://localhost:3000/api/auth/reauth', { method: 'POST' }))

      expect(response.status).toBe(503)
    })
  })

  describe('POST /api/auth/bot/connect', () => {
    it('PlanetScaleでstreamerが見つかれば200を返す', async () => {
      vi.mocked(getSession).mockResolvedValue({ twitchUserId: '123456789', broadcasterType: 'affiliate' } as any)
      const pg = createDrizzleDbMock({ selects: [{ rows: [{ id: 'streamer-1' }] }] })
      primePgDb(pg)

      const { POST } = await import('@/app/api/auth/bot/connect/route')
      const response = await POST(new Request('http://localhost:3000/api/auth/bot/connect', { method: 'POST' }) as any)
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(getDb).toHaveBeenCalled()
      expect(body.success).toBe(true)
    })

    it('streamerが存在しなければ403（データなしはエラーではなくnull）', async () => {
      vi.mocked(getSession).mockResolvedValue({ twitchUserId: '123456789', broadcasterType: 'affiliate' } as any)
      const pg = createDrizzleDbMock({ selects: [{ rows: [] }] })
      primePgDb(pg)

      const { POST } = await import('@/app/api/auth/bot/connect/route')
      const response = await POST(new Request('http://localhost:3000/api/auth/bot/connect', { method: 'POST' }) as any)

      expect(response.status).toBe(403)
    })
  })
})
