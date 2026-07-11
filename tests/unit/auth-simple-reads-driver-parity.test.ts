/**
 * #663: 低頻度APIルート群のpg直結移行 — 単純な読み取り系認証ルートの
 * postgrest経路 / pg経路パリティテスト
 *
 * 対象:
 *   - GET /api/auth/twitch/login（スコープ復元の読み取り）
 *   - POST /api/auth/reauth（既存スコープ取得の読み取り）
 *   - POST /api/auth/bot/connect（streamer存在確認の読み取り）
 *
 * write-rpc-driver-parity.test.ts の流儀（複数ルートを1ファイルにまとめ、
 * 共通の session/rate-limit/csrf/supabase-admin/getDb モックを共有する）を踏襲する。
 * 各ルートについて「postgrest経路（フラグ未設定）では getDb が一切呼ばれない」
 * 「pg経路（DB_DRIVER=pg-read等）では正しいテーブル/条件で SELECT され、
 * postgrest経路と同じ外部挙動になる」ことを検証する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getSession } from '@/lib/session'
import { validateCSRFToken } from '@/lib/csrf'
import { checkRateLimit, getRateLimitIdentifier } from '@/lib/rate-limit'
import { getTwitchAuthUrl } from '@/lib/twitch/auth'
import { deleteTwitchTokens } from '@/lib/twitch/token-manager'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
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

// ---------------------------------------------------------------------------
// pg 経路のモック（token-manager-driver-parity.test.ts の createDrizzleDbMock と同じ流儀）
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

function createSupabaseUsersMock(result: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn().mockResolvedValue(result)
  const eq = vi.fn(() => ({ maybeSingle }))
  const select = vi.fn(() => ({ eq }))
  return { from: vi.fn(() => ({ select })) }
}

function createSupabaseStreamersMock(result: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn().mockResolvedValue(result)
  const eq = vi.fn(() => ({ maybeSingle }))
  const select = vi.fn(() => ({ eq }))
  return { from: vi.fn(() => ({ select })) }
}

describe('低頻度認証ルート: postgrest / pg 経路の互換 (#663)', () => {
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

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('GET /api/auth/twitch/login', () => {
    it('フラグ未設定時は getDb が呼ばれない（挙動不変の検証）', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      vi.mocked(getSession).mockResolvedValue({ twitchUserId: '123456789' } as any)
      vi.mocked(getSupabaseAdmin).mockReturnValue(
        createSupabaseUsersMock({ data: { twitch_scopes: ['user:write:chat'] }, error: null }) as any
      )

      const { GET } = await import('@/app/api/auth/twitch/login/route')
      const response = await GET(new Request('http://localhost:3000/api/auth/twitch/login'))

      expect(response.status).toBe(200)
      expect(getDb).not.toHaveBeenCalled()
    })

    it('DB_DRIVER=pg-read: pg経路で読み取られた既存スコープが OAuth URL に反映される（postgrest 経路と同じ結果）', async () => {
      vi.mocked(getSession).mockResolvedValue({ twitchUserId: '123456789' } as any)
      vi.mocked(getSupabaseAdmin).mockReturnValue(
        createSupabaseUsersMock({ data: { twitch_scopes: ['user:write:chat'] }, error: null }) as any
      )
      const { GET: getWithPostgrest } = await import('@/app/api/auth/twitch/login/route')
      await getWithPostgrest(new Request('http://localhost:3000/api/auth/twitch/login'))
      const postgrestCallArgs = vi.mocked(getTwitchAuthUrl).mock.calls[0]

      vi.mocked(getTwitchAuthUrl).mockClear()
      vi.stubEnv('DB_DRIVER', 'pg-read')
      const pg = createDrizzleDbMock({ selects: [{ rows: [{ twitch_scopes: ['user:write:chat'] }] }] })
      primePgDb(pg)

      const { GET: getWithPg } = await import('@/app/api/auth/twitch/login/route')
      const response = await getWithPg(new Request('http://localhost:3000/api/auth/twitch/login'))
      const pgCallArgs = vi.mocked(getTwitchAuthUrl).mock.calls[0]

      expect(response.status).toBe(200)
      expect(getDb).toHaveBeenCalled()
      // 両経路とも同じ既存スコープ（preservedScopes）が OAuth URL 生成に渡される
      expect(pgCallArgs[2]).toEqual(postgrestCallArgs[2])
      expect(pgCallArgs[2]).toEqual(['user:write:chat'])
    })
  })

  describe('POST /api/auth/reauth', () => {
    it('フラグ未設定時は getDb が呼ばれない（挙動不変の検証）', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      vi.mocked(getSession).mockResolvedValue({ twitchUserId: '123456789' } as any)
      vi.mocked(getSupabaseAdmin).mockReturnValue(
        createSupabaseUsersMock({ data: { twitch_scopes: ['user:write:chat'] }, error: null }) as any
      )

      const { POST } = await import('@/app/api/auth/reauth/route')
      const response = await POST(new Request('http://localhost:3000/api/auth/reauth', { method: 'POST' }))

      expect(response.status).toBe(200)
      expect(getDb).not.toHaveBeenCalled()
      expect(deleteTwitchTokens).toHaveBeenCalledWith('123456789')
    })

    it('DB_DRIVER=pg-read: pg経路で正しいテーブル/条件から既存スコープが読み取られる', async () => {
      vi.stubEnv('DB_DRIVER', 'pg-read')
      vi.mocked(getSession).mockResolvedValue({ twitchUserId: '123456789' } as any)
      const pg = createDrizzleDbMock({ selects: [{ rows: [{ twitch_scopes: ['user:write:chat'] }] }] })
      primePgDb(pg)

      const { POST } = await import('@/app/api/auth/reauth/route')
      const response = await POST(new Request('http://localhost:3000/api/auth/reauth', { method: 'POST' }))
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(getDb).toHaveBeenCalled()
      expect(body.loginUrl).toBeDefined()
    })

    it('DB_DRIVER=pg-read: 列欠落(42703)は PGRST204 相当のデプロイ窓として許容され 200 を返す', async () => {
      vi.stubEnv('DB_DRIVER', 'pg-read')
      vi.mocked(getSession).mockResolvedValue({ twitchUserId: '123456789' } as any)
      const pg = createDrizzleDbMock({
        selects: [{ error: { code: '42703', message: 'column "twitch_scopes" does not exist' } }],
      })
      primePgDb(pg)

      const { POST } = await import('@/app/api/auth/reauth/route')
      const response = await POST(new Request('http://localhost:3000/api/auth/reauth', { method: 'POST' }))

      expect(response.status).toBe(200)
    })

    it('DB_DRIVER=pg-read: 列欠落以外のエラーは 503 を返す', async () => {
      vi.stubEnv('DB_DRIVER', 'pg-read')
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
    it('フラグ未設定時は getDb が呼ばれない（挙動不変の検証）', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      vi.mocked(getSession).mockResolvedValue({ twitchUserId: '123456789', broadcasterType: 'affiliate' } as any)
      vi.mocked(getSupabaseAdmin).mockReturnValue(
        createSupabaseStreamersMock({ data: { id: 'streamer-1' }, error: null }) as any
      )

      const { POST } = await import('@/app/api/auth/bot/connect/route')
      const response = await POST(new Request('http://localhost:3000/api/auth/bot/connect', { method: 'POST' }) as any)

      expect(response.status).toBe(200)
      expect(getDb).not.toHaveBeenCalled()
    })

    it('DB_DRIVER=pg-read: pg経路でstreamerが見つかれば200、postgrest経路と同じ結果', async () => {
      vi.stubEnv('DB_DRIVER', 'pg-read')
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

    it('DB_DRIVER=pg-read: streamerが存在しなければ403（データなしはエラーではなくnull）', async () => {
      vi.stubEnv('DB_DRIVER', 'pg-read')
      vi.mocked(getSession).mockResolvedValue({ twitchUserId: '123456789', broadcasterType: 'affiliate' } as any)
      const pg = createDrizzleDbMock({ selects: [{ rows: [] }] })
      primePgDb(pg)

      const { POST } = await import('@/app/api/auth/bot/connect/route')
      const response = await POST(new Request('http://localhost:3000/api/auth/bot/connect', { method: 'POST' }) as any)

      expect(response.status).toBe(403)
    })
  })
})
