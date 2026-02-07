import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/storage-bonus/vote-campaign/route'
import { getSession } from '@/lib/session'
import { validateCSRFToken } from '@/lib/csrf'
import { createMockQueryBuilder, createMockResponse } from '../utils/supabase-mock'
import { VOTE_CAMPAIGN_CONFIG } from '@/lib/constants'

vi.mock('@/lib/session')
vi.mock('@/lib/csrf')
vi.mock('@/lib/logger')
vi.mock('@/lib/sentry/error-handler')
vi.mock('@/lib/supabase/admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/admin')>()
  return {
    ...actual,
    getSupabaseAdmin: vi.fn(),
  }
})

const mockGetSession = vi.mocked(getSession)
const mockValidateCSRFToken = vi.mocked(validateCSRFToken)

function createRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/storage-bonus/vote-campaign', {
    method: 'POST',
    headers: {
      'X-CSRF-Token': 'test-csrf-token',
    },
  })
}

/**
 * select + insert パターン用のモッククライアントを生成
 * route.ts の処理フロー:
 *   1. from('streamers').select('id').eq(...).maybeSingle()  → 既存streamer検索
 *   2. from('streamers').insert(...).select('id').single()   → 新規streamer作成（既存なしの場合）
 *   3. from('streamer_storage_bonus').insert(...)            → ボーナス挿入
 */
function createMockClient(options: {
  existingStreamer?: { id: string } | null
  insertStreamerResult?: { data: unknown; error: unknown }
  insertBonusResult?: { data: unknown; error: unknown }
}) {
  const {
    existingStreamer = null,
    insertBonusResult = { data: null, error: null },
  } = options

  let callCount = 0
  return {
    from: vi.fn((table: string) => {
      callCount++
      if (table === 'streamers' && callCount === 1) {
        // 1回目: 既存streamer検索
        const selectQuery = createMockQueryBuilder()
        ;(selectQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue(
          createMockResponse(existingStreamer)
        )
        return selectQuery
      }
      if (table === 'streamers' && callCount === 2) {
        // 2回目: 新規streamer作成
        const insertQuery = createMockQueryBuilder()
        const result = options.insertStreamerResult || createMockResponse({ id: 'new-streamer-uuid' })
        ;(insertQuery.insert as ReturnType<typeof vi.fn>).mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue(result),
          }),
        })
        return insertQuery
      }
      if (table === 'streamer_storage_bonus') {
        // ボーナス挿入
        const bonusQuery = createMockQueryBuilder()
        ;(bonusQuery.insert as ReturnType<typeof vi.fn>).mockResolvedValue(insertBonusResult)
        return bonusQuery
      }
      return createMockQueryBuilder()
    }),
  }
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

  it('should create streamer record if not exists and apply bonus', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    const mockClient = createMockClient({
      existingStreamer: null, // streamer未存在 → 新規作成
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue(mockClient as unknown as ReturnType<typeof getSupabaseAdmin>)

    const response = await POST(createRequest())
    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.success).toBe(true)
  })

  it('should use existing streamer record without overwriting (data protection)', async () => {
    // 既存のアフィリエイト配信者 → selectで取得のみ、insertは呼ばれない
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    const mockClient = createMockClient({
      existingStreamer: { id: 'existing-affiliate-uuid' },
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue(mockClient as unknown as ReturnType<typeof getSupabaseAdmin>)

    const response = await POST(createRequest())
    expect(response.status).toBe(200)

    // streamersテーブルへのfrom呼び出しは1回のみ（selectのみ、insertなし）
    const streamerCalls = mockClient.from.mock.calls.filter(([t]: [string]) => t === 'streamers')
    expect(streamerCalls).toHaveLength(1)
  })

  it('should return 409 when bonus already applied (UNIQUE constraint violation)', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    const uniqueError = { code: '23505', message: 'duplicate key value violates unique constraint' }
    const mockClient = createMockClient({
      existingStreamer: { id: 'existing-streamer-uuid' },
      insertBonusResult: { data: null, error: uniqueError },
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue(mockClient as unknown as ReturnType<typeof getSupabaseAdmin>)

    const response = await POST(createRequest())
    expect(response.status).toBe(409)
    const data = await response.json()
    expect(data.error).toBe('このキャンペーンは既に適用済みです')
  })

  it('should handle race condition when creating streamer (23505 on insert)', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')

    // レースコンディションをシミュレート:
    // 1. select → null (未存在)
    // 2. insert → 23505エラー (他のリクエストが先に作成)
    // 3. retry select → 成功
    let callCount = 0
    const mockClient = {
      from: vi.fn((table: string) => {
        callCount++
        if (table === 'streamers' && callCount === 1) {
          // 1回目 select: 未存在
          const selectQuery = createMockQueryBuilder()
          ;(selectQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue(
            createMockResponse(null)
          )
          return selectQuery
        }
        if (table === 'streamers' && callCount === 2) {
          // insert: 23505エラー
          const insertQuery = createMockQueryBuilder()
          const raceError = { code: '23505', message: 'duplicate key value', name: 'PostgrestError' }
          ;(insertQuery.insert as ReturnType<typeof vi.fn>).mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue(createMockResponse(null, raceError)),
            }),
          })
          return insertQuery
        }
        if (table === 'streamers' && callCount === 3) {
          // 3回目 retry select: 成功（他のリクエストで作成済み）
          const retryQuery = createMockQueryBuilder()
          ;(retryQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue(
            createMockResponse({ id: 'race-streamer-uuid' })
          )
          return retryQuery
        }
        if (table === 'streamer_storage_bonus') {
          // ボーナス挿入成功
          const bonusQuery = createMockQueryBuilder()
          ;(bonusQuery.insert as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null, error: null })
          return bonusQuery
        }
        return createMockQueryBuilder()
      }),
    }

    vi.mocked(getSupabaseAdmin).mockReturnValue(mockClient as unknown as ReturnType<typeof getSupabaseAdmin>)

    const response = await POST(createRequest())
    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.success).toBe(true)
  })
})

describe('getStorageBonusBytes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should return 0 when streamer has no bonuses', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')

    const mockQuery = createMockQueryBuilder()
    ;(mockQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue(
      createMockResponse({ streamer_storage_bonus: [] })
    )

    vi.mocked(getSupabaseAdmin).mockReturnValue({
      from: vi.fn(() => mockQuery),
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const { getStorageBonusBytes } = await import('@/lib/storage-db')
    const result = await getStorageBonusBytes('user123')
    expect(result).toBe(0)
  })

  it('should return correct bytes for single bonus', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')

    const mockQuery = createMockQueryBuilder()
    ;(mockQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue(
      createMockResponse({ streamer_storage_bonus: [{ amount_mb: 5 }] })
    )

    vi.mocked(getSupabaseAdmin).mockReturnValue({
      from: vi.fn(() => mockQuery),
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const { getStorageBonusBytes } = await import('@/lib/storage-db')
    const result = await getStorageBonusBytes('user123')
    // 5MB = 5 * 1024 * 1024 = 5242880 bytes
    expect(result).toBe(5 * 1024 * 1024)
  })

  it('should sum multiple bonuses', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')

    const mockQuery = createMockQueryBuilder()
    ;(mockQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue(
      createMockResponse({
        streamer_storage_bonus: [
          { amount_mb: 5 },
          { amount_mb: 3 },
          { amount_mb: 2 },
        ],
      })
    )

    vi.mocked(getSupabaseAdmin).mockReturnValue({
      from: vi.fn(() => mockQuery),
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const { getStorageBonusBytes } = await import('@/lib/storage-db')
    const result = await getStorageBonusBytes('user123')
    // 10MB = 10 * 1024 * 1024
    expect(result).toBe(10 * 1024 * 1024)
  })

  it('should return 0 when streamer not found', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')

    const mockQuery = createMockQueryBuilder()
    ;(mockQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue(
      createMockResponse(null)
    )

    vi.mocked(getSupabaseAdmin).mockReturnValue({
      from: vi.fn(() => mockQuery),
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const { getStorageBonusBytes } = await import('@/lib/storage-db')
    const result = await getStorageBonusBytes('nonexistent-user')
    expect(result).toBe(0)
  })
})
