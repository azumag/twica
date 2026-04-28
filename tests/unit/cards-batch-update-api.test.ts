import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/cards/batch-update/route'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { checkRateLimit } from '@/lib/rate-limit'
import { validateCSRFToken } from '@/lib/csrf'
import { validateContentType } from '@/lib/request-validation'
import { createMockQueryBuilder, createMockResponse } from '../utils/supabase-mock'

vi.mock('@/lib/session')
vi.mock('@/lib/rate-limit')
vi.mock('@/lib/csrf')
vi.mock('@/lib/request-validation')
vi.mock('@/lib/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/constants')>()
  return {
    ...actual,
  }
})
vi.mock('@/lib/supabase/admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/admin')>()
  return {
    ...actual,
    getSupabaseAdmin: vi.fn(),
  }
})

const mockGetSession = vi.mocked(getSession)
const mockCheckRateLimit = vi.mocked(checkRateLimit)
const mockValidateCSRFToken = vi.mocked(validateCSRFToken)
const mockValidateContentType = vi.mocked(validateContentType)
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures)

/**
 * batch-update APIルートでは from() と rpc() の両方を使うため、
 * SupabaseMockBuilder ではなく手動でモックを構築する
 *
 * 呼び出し順序:
 * 1. from("streamers").select().eq().eq().maybeSingle()  → ストリーマー確認
 * 2. from("cards").select("id").eq().in()                → カード所有権確認（暗黙のawait）
 * 3. rpc("batch_update_card_drop_rates", ...)            → 一括更新
 * 4. from("cards").select().eq().in()                    → 更新後データ取得（暗黙のawait）
 */
function createBatchUpdateMock(options: {
  streamer?: { id: string; twitch_user_id: string } | null
  existingCards?: { id: string }[]
  rpcResult?: { updated_count: number } | null
  rpcError?: Error | null
  updatedCards?: Record<string, unknown>[]
  updatedCardsError?: Error | null
}) {
  let fromCallCount = 0

  // from()が呼ばれるたびに異なるクエリビルダーを返す
  const fromMock = vi.fn().mockImplementation((table: string) => {
    fromCallCount++

    if (table === 'streamers') {
      // 1回目: ストリーマー所有権確認
      const qb = createMockQueryBuilder()
      ;(qb.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue(
        createMockResponse(options.streamer ?? null)
      )
      return qb
    }

    if (table === 'cards') {
      if (fromCallCount <= 2) {
        // 2回目: カード所有権確認（from("cards")の1回目）
        // in() の後に暗黙の await で then() が呼ばれるため、
        // チェーンの最終メソッドが Promise を返す必要がある
        const qb = createMockQueryBuilder()
        // in() メソッドが呼ばれた時点で結果を返すようにする
        const resultPromise = Promise.resolve(
          createMockResponse(options.existingCards ?? [])
        )
        ;(qb.in as ReturnType<typeof vi.fn>).mockReturnValue({
          ...qb,
          then: resultPromise.then.bind(resultPromise),
        })
        return qb
      } else {
        // 3回目: 更新後データ取得（from("cards")の2回目）
        const qb = createMockQueryBuilder()
        const resultPromise = Promise.resolve(
          createMockResponse(options.updatedCards ?? [], options.updatedCardsError ?? null)
        )
        ;(qb.in as ReturnType<typeof vi.fn>).mockReturnValue({
          ...qb,
          then: resultPromise.then.bind(resultPromise),
        })
        return qb
      }
    }

    return createMockQueryBuilder()
  })

  // rpc() モック
  const rpcMock = vi.fn().mockResolvedValue({
    data: options.rpcResult ?? null,
    error: options.rpcError ?? null,
  })

  return { from: fromMock, rpc: rpcMock }
}

function createRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/cards/batch-update', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

describe('POST /api/cards/batch-update', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // 認証・認可のデフォルトモック（全テストで通過させる）
    mockGetSession.mockResolvedValue({
      twitchUserId: 'twitch-user-123',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/avatar.jpg',
      broadcasterType: 'affiliate',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: 1,
    })

    mockCanUseStreamerFeatures.mockReturnValue(true)
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Date.now() + 60000,
    })

    mockValidateCSRFToken.mockResolvedValue({ valid: true })
    mockValidateContentType.mockReturnValue(null)
  })

  describe('重複IDバリデーション', () => {
    it('同一カードIDが含まれる場合は400を返す', async () => {
      // ストリーマー確認を通過させるため、最低限のモックが必要
      const mockSupabase = createBatchUpdateMock({
        streamer: { id: 'streamer-1', twitch_user_id: 'twitch-user-123' },
      })
      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as unknown as ReturnType<typeof getSupabaseAdmin>)

      // 同一ID "card-1" を2つ含むリクエスト
      const request = createRequest({
        streamerId: 'streamer-1',
        updates: [
          { id: 'card-1', dropRate: 0.5 },
          { id: 'card-1', dropRate: 0.3 },
          { id: 'card-2', dropRate: 0.2 },
        ],
      })

      const response = await POST(request)

      expect(response.status).toBe(400)
      const data = await response.json()
      expect(data.error).toBe('同じカードIDが複数含まれています')
    })

    it('全て異なるカードIDであれば重複チェックを通過する', async () => {
      const cardIds = ['card-1', 'card-2', 'card-3']
      const mockSupabase = createBatchUpdateMock({
        streamer: { id: 'streamer-1', twitch_user_id: 'twitch-user-123' },
        existingCards: cardIds.map(id => ({ id })),
        rpcResult: { updated_count: 3 },
        updatedCards: cardIds.map(id => ({ id, streamer_id: 'streamer-1', drop_rate: 0.5 })),
      })
      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as unknown as ReturnType<typeof getSupabaseAdmin>)

      const request = createRequest({
        streamerId: 'streamer-1',
        updates: [
          { id: 'card-1', dropRate: 0.5 },
          { id: 'card-2', dropRate: 0.3 },
          { id: 'card-3', dropRate: 0.2 },
        ],
      })

      const response = await POST(request)

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.success).toBe(true)
      expect(data.updated).toBe(3)
    })
  })

  describe('RPC呼び出し', () => {
    it('batch_update_card_drop_rates RPCに正しいパラメータを渡す', async () => {
      const cardIds = ['card-1', 'card-2']
      const mockSupabase = createBatchUpdateMock({
        streamer: { id: 'streamer-1', twitch_user_id: 'twitch-user-123' },
        existingCards: cardIds.map(id => ({ id })),
        rpcResult: { updated_count: 2 },
        updatedCards: cardIds.map(id => ({ id, streamer_id: 'streamer-1', drop_rate: 0.5 })),
      })
      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as unknown as ReturnType<typeof getSupabaseAdmin>)

      const request = createRequest({
        streamerId: 'streamer-1',
        updates: [
          { id: 'card-1', dropRate: 0.5 },
          { id: 'card-2', dropRate: 0.3 },
        ],
      })

      await POST(request)

      // RPC関数名とパラメータの検証
      expect(mockSupabase.rpc).toHaveBeenCalledWith(
        'batch_update_card_drop_rates',
        {
          p_streamer_id: 'streamer-1',
          p_updates: [
            { id: 'card-1', drop_rate: 0.5 },
            { id: 'card-2', drop_rate: 0.3 },
          ],
        }
      )
    })

    it('RPCエラー時はデータベースエラーレスポンスを返す', async () => {
      const mockSupabase = createBatchUpdateMock({
        streamer: { id: 'streamer-1', twitch_user_id: 'twitch-user-123' },
        existingCards: [{ id: 'card-1' }],
        rpcError: new Error('RPC function error'),
      })
      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as unknown as ReturnType<typeof getSupabaseAdmin>)

      const request = createRequest({
        streamerId: 'streamer-1',
        updates: [{ id: 'card-1', dropRate: 0.5 }],
      })

      const response = await POST(request)

      // handleDatabaseErrorが500を返す
      expect(response.status).toBe(500)
    })

    it('更新件数が期待と異なる場合は部分更新エラーを返す', async () => {
      const mockSupabase = createBatchUpdateMock({
        streamer: { id: 'streamer-1', twitch_user_id: 'twitch-user-123' },
        existingCards: [{ id: 'card-1' }, { id: 'card-2' }],
        // 2件送ったが1件しか更新されなかった
        rpcResult: { updated_count: 1 },
      })
      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as unknown as ReturnType<typeof getSupabaseAdmin>)

      const request = createRequest({
        streamerId: 'streamer-1',
        updates: [
          { id: 'card-1', dropRate: 0.5 },
          { id: 'card-2', dropRate: 0.3 },
        ],
      })

      const response = await POST(request)

      expect(response.status).toBe(500)
    })
  })

  describe('既存バリデーション（リグレッション防止）', () => {
    it('空のupdates配列は400を返す', async () => {
      const request = createRequest({
        streamerId: 'streamer-1',
        updates: [],
      })

      const response = await POST(request)

      expect(response.status).toBe(400)
    })

    it('バッチサイズ上限（100件）超過は400を返す', async () => {
      // 101件の更新データを生成
      const updates = Array.from({ length: 101 }, (_, i) => ({
        id: `card-${i}`,
        dropRate: 0.5,
      }))

      const request = createRequest({
        streamerId: 'streamer-1',
        updates,
      })

      const response = await POST(request)

      expect(response.status).toBe(400)
      const data = await response.json()
      expect(data.error).toContain('100')
    })

    it('不正なdropRate値は400を返す', async () => {
      const mockSupabase = createBatchUpdateMock({
        streamer: { id: 'streamer-1', twitch_user_id: 'twitch-user-123' },
      })
      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as unknown as ReturnType<typeof getSupabaseAdmin>)

      const request = createRequest({
        streamerId: 'streamer-1',
        updates: [{ id: 'card-1', dropRate: 1.5 }],  // 0〜1の範囲外
      })

      const response = await POST(request)

      expect(response.status).toBe(400)
    })
  })
})
