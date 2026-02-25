import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

// fetchをグローバルモック
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

/**
 * Supabase クエリビルダーのモック
 * hasTwitchSub は select→eq→maybeSingle のチェーンと update→eq のチェーンを両方使う。
 */
function createQueryBuilder(options: {
  selectData?: unknown
  selectError?: unknown
  updateError?: unknown
  /** update 後の .select().maybeSingle() が返すデータ（デフォルト: 更新成功） */
  updateData?: unknown
}) {
  const {
    selectData = null,
    selectError = null,
    updateError = null,
    updateData = { twitch_user_id: 'user-1' },
  } = options

  return {
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        maybeSingle: vi.fn().mockResolvedValue({ data: selectData, error: selectError }),
      }),
    }),
    // update().eq().select().maybeSingle() チェーンに対応
    // Supabase JS v2 は .update().eq() だけではマッチ0行でも error=null を返すため、
    // .select().maybeSingle() で実際の更新行を確認するパターン
    update: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: updateData, error: updateError }),
        }),
      }),
    }),
  }
}

describe('sub-check', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockReset()
  })

  function setupMocks(options: {
    broadcasterIdSet?: boolean
    clientId?: string
    selectData?: unknown
    selectError?: unknown
    updateError?: unknown
    updateData?: unknown
    accessToken?: string | null
  } = {}) {
    const {
      broadcasterIdSet = true,
      clientId = 'test-client-id',
      selectData = null,
      selectError = null,
      updateError = null,
      updateData = { twitch_user_id: 'user-1' },
      accessToken = 'test-token',
    } = options

    const queryBuilder = createQueryBuilder({ selectData, selectError, updateError, updateData })

    vi.doMock('@/lib/env-validation', () => ({
      getEnvVar: vi.fn((key: string) => {
        if (key === 'TWITCH_BROADCASTER_ID') return broadcasterIdSet ? 'broadcaster-123' : undefined
        if (key === 'NEXT_PUBLIC_TWITCH_CLIENT_ID') return clientId
        return undefined
      }),
    }))

    vi.doMock('@/lib/supabase/admin', () => ({
      getSupabaseAdmin: vi.fn(() => ({
        from: vi.fn(() => queryBuilder),
      })),
    }))

    vi.doMock('@/lib/twitch/token-manager', () => ({
      getTwitchAccessToken: vi.fn().mockResolvedValue(accessToken),
    }))

    vi.doMock('@/lib/twitch/auth', () => ({
      ADDITIONAL_SCOPES: { USER_READ_SUBSCRIPTIONS: 'user:read:subscriptions' },
    }))

    return { queryBuilder }
  }

  describe('isTwitchSubCheckEnabled', () => {
    it('TWITCH_BROADCASTER_ID が設定されている場合 true を返す', async () => {
      setupMocks({ broadcasterIdSet: true })
      const { isTwitchSubCheckEnabled } = await import('@/lib/twitch/sub-check')
      expect(isTwitchSubCheckEnabled()).toBe(true)
    })

    it('TWITCH_BROADCASTER_ID が未設定の場合 false を返す', async () => {
      setupMocks({ broadcasterIdSet: false })
      const { isTwitchSubCheckEnabled } = await import('@/lib/twitch/sub-check')
      expect(isTwitchSubCheckEnabled()).toBe(false)
    })
  })

  describe('hasTwitchSub', () => {
    it('機能無効時は false を返す', async () => {
      setupMocks({ broadcasterIdSet: false })
      const { hasTwitchSub } = await import('@/lib/twitch/sub-check')
      expect(await hasTwitchSub('user-1')).toBe(false)
    })

    it('ユーザー未取得時は false を返す', async () => {
      setupMocks({ selectData: null })
      const { hasTwitchSub } = await import('@/lib/twitch/sub-check')
      expect(await hasTwitchSub('user-1')).toBe(false)
    })

    it('DB エラー時は false を返す', async () => {
      setupMocks({ selectError: { message: 'DB error' } })
      const { hasTwitchSub } = await import('@/lib/twitch/sub-check')
      expect(await hasTwitchSub('user-1')).toBe(false)
    })

    it('user:read:subscriptions スコープ未付与時は false を返す', async () => {
      setupMocks({
        selectData: {
          twitch_scopes: ['user:write:chat'],
          twitch_sub_verified_at: null,
          twitch_has_sub: false,
        },
      })
      const { hasTwitchSub } = await import('@/lib/twitch/sub-check')
      expect(await hasTwitchSub('user-1')).toBe(false)
    })

    it('twitch_scopes が null の場合は false を返す', async () => {
      setupMocks({
        selectData: {
          twitch_scopes: null,
          twitch_sub_verified_at: null,
          twitch_has_sub: false,
        },
      })
      const { hasTwitchSub } = await import('@/lib/twitch/sub-check')
      expect(await hasTwitchSub('user-1')).toBe(false)
    })

    it('キャッシュ有効期間内なら DB の結果を返す（true）', async () => {
      setupMocks({
        selectData: {
          twitch_scopes: ['user:read:subscriptions'],
          twitch_sub_verified_at: new Date().toISOString(),
          twitch_has_sub: true,
        },
      })
      const { hasTwitchSub } = await import('@/lib/twitch/sub-check')
      expect(await hasTwitchSub('user-1')).toBe(true)
    })

    it('キャッシュ有効期間内なら DB の結果を返す（false）', async () => {
      setupMocks({
        selectData: {
          twitch_scopes: ['user:read:subscriptions'],
          twitch_sub_verified_at: new Date().toISOString(),
          twitch_has_sub: false,
        },
      })
      const { hasTwitchSub } = await import('@/lib/twitch/sub-check')
      expect(await hasTwitchSub('user-1')).toBe(false)
    })

    it('キャッシュ期限切れ + API 成功時は API の結果を返す', async () => {
      const expiredTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
      setupMocks({
        selectData: {
          twitch_scopes: ['user:read:subscriptions'],
          twitch_sub_verified_at: expiredTime,
          twitch_has_sub: false,
        },
      })
      mockFetch.mockResolvedValue({ ok: true, status: 200 })

      const { hasTwitchSub } = await import('@/lib/twitch/sub-check')
      const result = await hasTwitchSub('user-1')
      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledOnce()
    })

    it('キャッシュ期限切れ + API エラー時は前回の結果を保持する', async () => {
      const expiredTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
      setupMocks({
        selectData: {
          twitch_scopes: ['user:read:subscriptions'],
          twitch_sub_verified_at: expiredTime,
          twitch_has_sub: true,
        },
      })
      // 500 エラー → { hasSub: null, authError: false }
      mockFetch.mockResolvedValue({ ok: false, status: 500 })

      const { hasTwitchSub } = await import('@/lib/twitch/sub-check')
      const result = await hasTwitchSub('user-1')
      // 前回値 (true) を保持
      expect(result).toBe(true)
    })

    it('キャッシュ期限切れ + API 成功 + DB 更新0行でも API の結果を返す', async () => {
      const expiredTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
      setupMocks({
        selectData: {
          twitch_scopes: ['user:read:subscriptions'],
          twitch_sub_verified_at: expiredTime,
          twitch_has_sub: false,
        },
        updateData: null, // 0行更新（ユーザー削除済み等）
      })
      mockFetch.mockResolvedValue({ ok: true, status: 200 })

      const { logger } = await import('@/lib/logger')
      const { hasTwitchSub } = await import('@/lib/twitch/sub-check')
      const result = await hasTwitchSub('user-1')
      // バックグラウンド処理なので API 結果をそのまま返す
      expect(result).toBe(true)
      expect(logger.error).toHaveBeenCalledWith(
        '[TwitchSub] Failed to update sub cache:',
        expect.objectContaining({ twitchUserId: 'user-1', updatedUser: null })
      )
    })

    it('キャッシュ期限切れ + API 成功 + DB updateError でもAPI の結果を返す', async () => {
      const expiredTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
      setupMocks({
        selectData: {
          twitch_scopes: ['user:read:subscriptions'],
          twitch_sub_verified_at: expiredTime,
          twitch_has_sub: false,
        },
        updateError: { message: 'DB connection error' },
        updateData: null,
      })
      mockFetch.mockResolvedValue({ ok: true, status: 200 })

      const { logger } = await import('@/lib/logger')
      const { hasTwitchSub } = await import('@/lib/twitch/sub-check')
      const result = await hasTwitchSub('user-1')
      expect(result).toBe(true)
      expect(logger.error).toHaveBeenCalledWith(
        '[TwitchSub] Failed to update sub cache:',
        expect.objectContaining({
          twitchUserId: 'user-1',
          error: { message: 'DB connection error' },
        })
      )
    })

    it('キャッシュ期限切れ + API エラー + タイムスタンプ更新失敗でもログ出力して前回値を返す', async () => {
      const expiredTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
      setupMocks({
        selectData: {
          twitch_scopes: ['user:read:subscriptions'],
          twitch_sub_verified_at: expiredTime,
          twitch_has_sub: true,
        },
        updateData: null, // タイムスタンプ更新も0行
      })
      mockFetch.mockResolvedValue({ ok: false, status: 500 })

      const { logger } = await import('@/lib/logger')
      const { hasTwitchSub } = await import('@/lib/twitch/sub-check')
      const result = await hasTwitchSub('user-1')
      // 前回値を保持
      expect(result).toBe(true)
      expect(logger.error).toHaveBeenCalledWith(
        '[TwitchSub] Failed to update error cache timestamp:',
        expect.objectContaining({ twitchUserId: 'user-1', updatedTs: null })
      )
    })

    it('twitch_sub_verified_at 未設定時は API を呼び出す', async () => {
      setupMocks({
        selectData: {
          twitch_scopes: ['user:read:subscriptions'],
          twitch_sub_verified_at: null,
          twitch_has_sub: false,
        },
      })
      mockFetch.mockResolvedValue({ ok: false, status: 404 })

      const { hasTwitchSub } = await import('@/lib/twitch/sub-check')
      const result = await hasTwitchSub('user-1')
      expect(result).toBe(false)
      expect(mockFetch).toHaveBeenCalledOnce()
    })
  })

  describe('checkTwitchSubViaApi', () => {
    it('broadcaster ID 未設定時は { hasSub: null, authError: false } を返す', async () => {
      setupMocks({ broadcasterIdSet: false })
      const { checkTwitchSubViaApi } = await import('@/lib/twitch/sub-check')
      expect(await checkTwitchSubViaApi('user-1')).toEqual({ hasSub: null, authError: false })
    })

    it('アクセストークンなしで { hasSub: null, authError: false } を返す', async () => {
      setupMocks({ accessToken: null })
      const { checkTwitchSubViaApi } = await import('@/lib/twitch/sub-check')
      expect(await checkTwitchSubViaApi('user-1')).toEqual({ hasSub: null, authError: false })
    })

    it('200 レスポンスで { hasSub: true, authError: false } を返す', async () => {
      setupMocks()
      mockFetch.mockResolvedValue({ ok: true, status: 200 })

      const { checkTwitchSubViaApi } = await import('@/lib/twitch/sub-check')
      expect(await checkTwitchSubViaApi('user-1')).toEqual({ hasSub: true, authError: false })
    })

    it('404 レスポンスで { hasSub: false, authError: false } を返す', async () => {
      setupMocks()
      mockFetch.mockResolvedValue({ ok: false, status: 404 })

      const { checkTwitchSubViaApi } = await import('@/lib/twitch/sub-check')
      expect(await checkTwitchSubViaApi('user-1')).toEqual({ hasSub: false, authError: false })
    })

    it('401 レスポンスで { hasSub: null, authError: true } を返す', async () => {
      setupMocks()
      mockFetch.mockResolvedValue({ ok: false, status: 401 })

      const { checkTwitchSubViaApi } = await import('@/lib/twitch/sub-check')
      expect(await checkTwitchSubViaApi('user-1')).toEqual({ hasSub: null, authError: true })
    })

    it('403 レスポンスで { hasSub: null, authError: true } を返す', async () => {
      setupMocks()
      mockFetch.mockResolvedValue({ ok: false, status: 403 })

      const { checkTwitchSubViaApi } = await import('@/lib/twitch/sub-check')
      expect(await checkTwitchSubViaApi('user-1')).toEqual({ hasSub: null, authError: true })
    })

    it('500 レスポンスで { hasSub: null, authError: false } を返す', async () => {
      setupMocks()
      mockFetch.mockResolvedValue({ ok: false, status: 500 })

      const { checkTwitchSubViaApi } = await import('@/lib/twitch/sub-check')
      expect(await checkTwitchSubViaApi('user-1')).toEqual({ hasSub: null, authError: false })
    })

    it('ネットワークエラーで { hasSub: null, authError: false } を返す', async () => {
      setupMocks()
      mockFetch.mockRejectedValue(new Error('Network error'))

      const { checkTwitchSubViaApi } = await import('@/lib/twitch/sub-check')
      expect(await checkTwitchSubViaApi('user-1')).toEqual({ hasSub: null, authError: false })
    })

    it('正しい URL とヘッダーで API を呼び出す', async () => {
      setupMocks({ clientId: 'my-client-id' })
      mockFetch.mockResolvedValue({ ok: true, status: 200 })

      const { checkTwitchSubViaApi } = await import('@/lib/twitch/sub-check')
      await checkTwitchSubViaApi('user-42')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.twitch.tv/helix/subscriptions/user?broadcaster_id=broadcaster-123&user_id=user-42',
        {
          headers: {
            'Authorization': 'Bearer test-token',
            'Client-Id': 'my-client-id',
          },
        }
      )
    })
  })
})
