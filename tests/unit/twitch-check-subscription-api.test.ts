import { beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/auth/twitch/check-subscription/route'
import { validateCSRFToken } from '@/lib/csrf'
import { getSession } from '@/lib/session'
import { checkRateLimit, getRateLimitIdentifier } from '@/lib/rate-limit'
import { hasScope } from '@/lib/twitch/token-manager'
import { checkTwitchSubViaApi, isTwitchSubCheckEnabled } from '@/lib/twitch/sub-check'
import { getDb } from '@/lib/db/client'

vi.mock('@/lib/csrf')
vi.mock('@/lib/session')
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(),
  getRateLimitIdentifier: vi.fn(),
  rateLimits: { twitchCheckSubscription: {} },
}))
vi.mock('@/lib/twitch/token-manager', () => ({
  hasScope: vi.fn(),
  removeScope: vi.fn(),
}))
vi.mock('@/lib/twitch/sub-check', () => ({
  checkTwitchSubViaApi: vi.fn(),
  isTwitchSubCheckEnabled: vi.fn(),
}))
vi.mock('@/lib/db/client', () => ({ getDb: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const mockValidateCSRFToken = vi.mocked(validateCSRFToken)
const mockGetSession = vi.mocked(getSession)
const mockCheckRateLimit = vi.mocked(checkRateLimit)
const mockGetRateLimitIdentifier = vi.mocked(getRateLimitIdentifier)
const mockHasScope = vi.mocked(hasScope)
const mockCheckTwitchSubViaApi = vi.mocked(checkTwitchSubViaApi)
const mockIsTwitchSubCheckEnabled = vi.mocked(isTwitchSubCheckEnabled)

function createRequest(): Request {
  return new Request('http://localhost:3000/api/auth/twitch/check-subscription', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
  })
}

function createDbMock(options: {
  persistedRows: unknown[]
  readBackRows?: unknown[]
  persistError?: unknown
}) {
  const {
    persistedRows,
    readBackRows = persistedRows,
    persistError,
  } = options
  const returning = persistError
    ? vi.fn().mockRejectedValue(persistError)
    : vi.fn().mockResolvedValue(persistedRows)
  const onConflictDoUpdate = vi.fn().mockReturnValue({ returning })
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate })
  const insert = vi.fn().mockReturnValue({ values })

  const limit = vi.fn().mockResolvedValue(readBackRows)
  const where = vi.fn().mockReturnValue({ limit })
  const from = vi.fn().mockReturnValue({ where })
  const select = vi.fn().mockReturnValue({ from })

  return { insert, values, onConflictDoUpdate, returning, select, from, where, limit }
}

describe('POST /api/auth/twitch/check-subscription', () => {
  beforeEach(async () => {
    vi.clearAllMocks()

    mockValidateCSRFToken.mockResolvedValue({ valid: true })
    mockGetSession.mockResolvedValue({
      twitchUserId: '123456789',
      twitchUsername: 'test-user',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/avatar.png',
      broadcasterType: 'affiliate',
      expiresAt: Date.now() + 60_000,
      version: 1,
    })
    mockGetRateLimitIdentifier.mockResolvedValue('user:123456789')
    mockCheckRateLimit.mockResolvedValue({ success: true, limit: 5, remaining: 4, reset: Date.now() + 60_000 })
    mockHasScope.mockResolvedValue(true)
    mockCheckTwitchSubViaApi.mockResolvedValue({ hasSub: true, authError: false })
    mockIsTwitchSubCheckEnabled.mockReturnValue(true)
  })

  it('返却行が空かつ再読込で確認できない場合は saved=false を返す', async () => {
    vi.mocked(getDb).mockResolvedValue({
      db: createDbMock({ persistedRows: [], readBackRows: [] }),
    } as any)

    const response = await POST(createRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ success: true, hasSub: true, saved: false, saveFailureCode: 'NO_ROW_RETURNED' })
  })

  it('返却行が空でも再読込で保存を確認できれば saved=true を返す', async () => {
    vi.mocked(getDb).mockResolvedValue({
      db: createDbMock({
        persistedRows: [],
        readBackRows: [{
          twitch_has_sub: true,
          twitch_sub_verified_at: new Date().toISOString(),
        }],
      }),
    } as any)

    const response = await POST(createRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ success: true, hasSub: true, saved: true })
  })

  it('保存エラー時は500を返す', async () => {
    vi.mocked(getDb).mockResolvedValue({
      db: createDbMock({
        persistedRows: [],
        persistError: Object.assign(new Error('db error'), { code: '08006' }),
      }),
    } as any)

    const response = await POST(createRequest())
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body).toEqual({ error: 'Failed to save subscription status' })
  })

  it('42703（スキーマ未適用）時は保存をスキップして成功を返す', async () => {
    vi.mocked(getDb).mockResolvedValue({
      db: createDbMock({
        persistedRows: [],
        persistError: Object.assign(new Error('column not found'), { code: '42703' }),
      }),
    } as any)

    const response = await POST(createRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ success: true, hasSub: true, saved: false, saveFailureCode: '42703' })
  })

  it('保存成功時は saved=true を返す', async () => {
    vi.mocked(getDb).mockResolvedValue({
      db: createDbMock({
        persistedRows: [{ twitch_user_id: '123456789' }],
      }),
    } as any)

    const response = await POST(createRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ success: true, hasSub: true, saved: true })
  })
})
