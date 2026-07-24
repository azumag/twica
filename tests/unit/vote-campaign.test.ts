import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/storage-bonus/vote-campaign/route'
import { getSession } from '@/lib/session'
import { validateCSRFToken } from '@/lib/csrf'
import { VOTE_CAMPAIGN_CONFIG } from '@/lib/constants'
import { getDb } from '@/lib/db/client'

vi.mock('@/lib/session')
vi.mock('@/lib/csrf')
vi.mock('@/lib/logger')
vi.mock('@/lib/sentry/error-handler')
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ success: true, limit: 5, remaining: 4, reset: Date.now() + 60000 }),
  rateLimits: { voteCampaign: {} },
  getRateLimitIdentifier: vi.fn().mockResolvedValue('user:user123'),
}))

const mockGetSession = vi.mocked(getSession)
const mockValidateCSRFToken = vi.mocked(validateCSRFToken)

function createRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/storage-bonus/vote-campaign', {
    method: 'POST',
  })
}

/** routeとstorage helperが使うDrizzle select/insertの最小PlanetScale fixture。 */
function primeVoteDb(config: {
  selects?: Array<Array<Record<string, unknown>>>
  inserts?: Array<Array<Record<string, unknown>>>
}) {
  let selectIndex = 0
  let insertIndex = 0
  const db = {
    select: vi.fn(() => {
      const rows = config.selects?.[Math.min(selectIndex++, (config.selects?.length ?? 1) - 1)] ?? []
      const builder: any = {}
      builder.from = vi.fn(() => builder)
      builder.leftJoin = vi.fn(() => builder)
      builder.where = vi.fn(() => builder)
      builder.limit = vi.fn(() => builder)
      builder.then = (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject)
      return builder
    }),
    insert: vi.fn(() => {
      const rows = config.inserts?.[Math.min(insertIndex++, (config.inserts?.length ?? 1) - 1)] ?? []
      const builder: any = {}
      builder.values = vi.fn(() => builder)
      builder.returning = vi.fn(() => builder)
      builder.then = (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject)
      return builder
    }),
  }
  vi.mocked(getDb).mockResolvedValue({ db: db as never, sql: {} as never })
  return db
}

describe('POST /api/storage-bonus/vote-campaign', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // デフォルト: 有効なセッション、CSRF有効
    mockGetSession.mockResolvedValue({
      twitchUserId: 'user123',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/avatar.jpg',
      broadcasterType: '', // 非配信者でもOK
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: 1,
    })
    mockValidateCSRFToken.mockResolvedValue({ valid: true })

    // キャンペーン期間内にDateを固定
    vi.useFakeTimers()
    const campaignMidpoint = new Date(
      (VOTE_CAMPAIGN_CONFIG.START_DATE.getTime() + VOTE_CAMPAIGN_CONFIG.END_DATE.getTime()) / 2
    )
    vi.setSystemTime(campaignMidpoint)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should return 403 when CSRF token is invalid', async () => {
    mockValidateCSRFToken.mockResolvedValue({ valid: false })

    const response = await POST(createRequest())
    expect(response.status).toBe(403)
  })

  it('should return 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValue(null)

    const response = await POST(createRequest())
    expect(response.status).toBe(401)
  })

  it('should return 400 when campaign period has not started', async () => {
    vi.setSystemTime(new Date(VOTE_CAMPAIGN_CONFIG.START_DATE.getTime() - 1000))

    const response = await POST(createRequest())
    expect(response.status).toBe(400)
    const data = await response.json()
    expect(data.error).toBe('キャンペーン期間外です')
  })

  it('should return 400 when campaign period has ended', async () => {
    vi.setSystemTime(new Date(VOTE_CAMPAIGN_CONFIG.END_DATE.getTime() + 1000))

    const response = await POST(createRequest())
    expect(response.status).toBe(400)
    const data = await response.json()
    expect(data.error).toBe('キャンペーン期間外です')
  })

})

describe('getStorageBonusBytes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should return 0 when streamer has no bonuses', async () => {
    primeVoteDb({ selects: [[{ amount_mb: null }]] })

    const { getStorageBonusBytes } = await import('@/lib/storage-db')
    const result = await getStorageBonusBytes('user123')
    expect(result).toBe(0)
  })

  it('should return correct bytes for single bonus', async () => {
    primeVoteDb({ selects: [[{ amount_mb: 5 }]] })

    const { getStorageBonusBytes } = await import('@/lib/storage-db')
    const result = await getStorageBonusBytes('user123')
    // 5MB = 5 * 1024 * 1024 = 5242880 bytes
    expect(result).toBe(5 * 1024 * 1024)
  })

  it('should sum multiple bonuses', async () => {
    primeVoteDb({ selects: [[{ amount_mb: 5 }, { amount_mb: 3 }, { amount_mb: 2 }]] })

    const { getStorageBonusBytes } = await import('@/lib/storage-db')
    const result = await getStorageBonusBytes('user123')
    // 10MB = 10 * 1024 * 1024
    expect(result).toBe(10 * 1024 * 1024)
  })

  it('should return 0 when streamer not found', async () => {
    primeVoteDb({ selects: [[]] })

    const { getStorageBonusBytes } = await import('@/lib/storage-db')
    const result = await getStorageBonusBytes('nonexistent-user')
    expect(result).toBe(0)
  })
})

describe('POST /api/storage-bonus/vote-campaign - rate limit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSession.mockResolvedValue({
      twitchUserId: 'user123',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/avatar.jpg',
      broadcasterType: '',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: 1,
    })
    mockValidateCSRFToken.mockResolvedValue({ valid: true })
    vi.useFakeTimers()
    const campaignMidpoint = new Date(
      (VOTE_CAMPAIGN_CONFIG.START_DATE.getTime() + VOTE_CAMPAIGN_CONFIG.END_DATE.getTime()) / 2
    )
    vi.setSystemTime(campaignMidpoint)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should return 429 when rate limit exceeded', async () => {
    const { checkRateLimit } = await import('@/lib/rate-limit')
    const resetTime = Date.now() + 30000
    vi.mocked(checkRateLimit).mockResolvedValue({
      success: false,
      limit: 5,
      remaining: 0,
      reset: resetTime,
    })

    const response = await POST(createRequest())
    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBeTruthy()
  })

  it('should include Retry-After header with correct value', async () => {
    const { checkRateLimit } = await import('@/lib/rate-limit')
    const resetTime = Date.now() + 45000
    vi.mocked(checkRateLimit).mockResolvedValue({
      success: false,
      limit: 5,
      remaining: 0,
      reset: resetTime,
    })

    const response = await POST(createRequest())
    const retryAfter = Number(response.headers.get('Retry-After'))
    expect(retryAfter).toBe(45) // 45000ms = 45秒
  })
})

describe('POST /api/storage-bonus/vote-campaign - boundary values', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    // レート制限モックをリセット（fake timersでDate.now()が変わるため再設定が必要）
    const { checkRateLimit } = await import('@/lib/rate-limit')
    vi.mocked(checkRateLimit).mockResolvedValue({ success: true, limit: 5, remaining: 4, reset: Date.now() + 60000 })
    mockGetSession.mockResolvedValue({
      twitchUserId: 'user123',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/avatar.jpg',
      broadcasterType: '',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: 1,
    })
    mockValidateCSRFToken.mockResolvedValue({ valid: true })
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should return 200 at exactly START_DATE (boundary: period starts)', async () => {
    vi.setSystemTime(VOTE_CAMPAIGN_CONFIG.START_DATE)

    primeVoteDb({
      selects: [[{ id: 'existing-streamer-uuid' }]],
      inserts: [[{ id: 'bonus-1' }]],
    })

    const response = await POST(createRequest())
    expect(response.status).toBe(200)
  })

  it('should return 200 at exactly END_DATE (boundary: period still active)', async () => {
    vi.setSystemTime(VOTE_CAMPAIGN_CONFIG.END_DATE)

    primeVoteDb({
      selects: [[{ id: 'existing-streamer-uuid' }]],
      inserts: [[{ id: 'bonus-1' }]],
    })

    const response = await POST(createRequest())
    expect(response.status).toBe(200)
  })
})
