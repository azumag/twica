/**
 * Twitchサブスク判定の業務契約テスト。
 *
 * #803 以降のDB境界は getDb() のみ。キャッシュの読み書きは最小Drizzle fixtureで
 * 再現し、このファイルでは主に機能フラグ、キャッシュ期限、Twitch HTTP応答の分類を
 * 検証する。SQL形状の詳細は twitch-sub-check-driver-parity.test.ts が担当する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkTwitchSubViaApi,
  hasTwitchSub,
  isTwitchSubCheckEnabled,
} from '@/lib/twitch/sub-check'
import { getTwitchAccessToken } from '@/lib/twitch/token-manager'
import { getDb } from '@/lib/db/client'

vi.mock('@/lib/twitch/token-manager', () => ({
  getTwitchAccessToken: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

interface DbResponse {
  rows?: Array<Record<string, unknown>>
  error?: unknown
}

function createDrizzleDbMock(options: {
  select?: DbResponse
  update?: DbResponse
}) {
  const selectResponse = options.select ?? { rows: [] }
  const updateResponse = options.update ?? {
    rows: [{ twitch_user_id: 'user-1' }],
  }
  const update = vi.fn(() => {
    const resolve = () =>
      updateResponse.error
        ? Promise.reject(updateResponse.error)
        : Promise.resolve(updateResponse.rows ?? [])
    const builder: any = {
      set: vi.fn(() => builder),
      where: vi.fn(() => builder),
      returning: vi.fn(() => resolve()),
    }
    return builder
  })
  const select = vi.fn((fields: Record<string, unknown>) => {
    const resolve = () =>
      selectResponse.error
        ? Promise.reject(selectResponse.error)
        : Promise.resolve(
            (selectResponse.rows ?? []).map((row) =>
              Object.fromEntries(Object.keys(fields).map((key) => [key, row[key] ?? null]))
            )
          )
    const builder: any = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      then: (onFulfilled: any, onRejected: any) =>
        resolve().then(onFulfilled, onRejected),
    }
    return builder
  })
  return { db: { select, update }, update }
}

function primeDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any)
}

function cachedUser(overrides: Record<string, unknown> = {}) {
  return {
    twitch_scopes: ['user:read:subscriptions'],
    twitch_sub_verified_at: new Date().toISOString(),
    twitch_has_sub: true,
    ...overrides,
  }
}

describe('sub-check: PlanetScale/Drizzle', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('TWITCH_BROADCASTER_ID', 'broadcaster-123')
    vi.stubEnv('NEXT_PUBLIC_TWITCH_CLIENT_ID', 'client-123')
    vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  describe('isTwitchSubCheckEnabled', () => {
    it('broadcaster ID の有無を反映する', () => {
      expect(isTwitchSubCheckEnabled()).toBe(true)
      vi.stubEnv('TWITCH_BROADCASTER_ID', undefined)
      expect(isTwitchSubCheckEnabled()).toBe(false)
    })
  })

  describe('hasTwitchSub', () => {
    it('機能無効時はDB/APIを呼ばず false を返す', async () => {
      vi.stubEnv('TWITCH_BROADCASTER_ID', undefined)

      await expect(hasTwitchSub('user-1')).resolves.toBe(false)
      expect(getDb).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it.each([true, false])('1時間以内のキャッシュ値(%s)を返す', async (hasSub) => {
      const fixture = createDrizzleDbMock({
        select: { rows: [cachedUser({ twitch_has_sub: hasSub })] },
      })
      primeDb(fixture)

      await expect(hasTwitchSub('user-1')).resolves.toBe(hasSub)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('検証時刻がnullならTwitch APIを呼び、404を非サブスクとして保存する', async () => {
      const fixture = createDrizzleDbMock({
        select: {
          rows: [cachedUser({
            twitch_sub_verified_at: null,
            twitch_has_sub: true,
          })],
        },
      })
      primeDb(fixture)
      fetchMock.mockResolvedValue({ ok: false, status: 404 })

      await expect(hasTwitchSub('user-1')).resolves.toBe(false)
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(fixture.update).toHaveBeenCalledOnce()
    })

    it.each([
      ['ユーザーなし', []],
      ['scope未付与', [cachedUser({ twitch_scopes: ['user:write:chat'] })]],
      ['scope列null', [cachedUser({ twitch_scopes: null })]],
    ])('%s はAPIを呼ばず false を返す', async (_name, rows) => {
      const fixture = createDrizzleDbMock({ select: { rows } })
      primeDb(fixture)

      await expect(hasTwitchSub('user-1')).resolves.toBe(false)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('DB読み取りエラーを false へ安全側に倒す', async () => {
      const fixture = createDrizzleDbMock({
        select: { error: new Error('database unavailable') },
      })
      primeDb(fixture)

      await expect(hasTwitchSub('user-1')).resolves.toBe(false)
    })
  })

  describe('checkTwitchSubViaApi', () => {
    it('broadcaster ID 未設定時は判定不能で、DBトークンも読まない', async () => {
      vi.stubEnv('TWITCH_BROADCASTER_ID', undefined)

      await expect(checkTwitchSubViaApi('user-1')).resolves.toEqual({
        hasSub: null,
        authError: false,
      })
      expect(getTwitchAccessToken).not.toHaveBeenCalled()
    })

    it('アクセストークンなしは判定不能にする', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue(null)

      await expect(checkTwitchSubViaApi('user-1')).resolves.toEqual({
        hasSub: null,
        authError: false,
      })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it.each([
      [{ ok: true, status: 200 }, { hasSub: true, authError: false }],
      [{ ok: false, status: 404 }, { hasSub: false, authError: false }],
      [{ ok: false, status: 401 }, { hasSub: null, authError: true }],
      [{ ok: false, status: 403 }, { hasSub: null, authError: true }],
      [{ ok: false, status: 500 }, { hasSub: null, authError: false }],
    ])('Twitch HTTP応答 %j を業務結果へ分類する', async (response, expected) => {
      fetchMock.mockResolvedValue(response)

      await expect(checkTwitchSubViaApi('user-1')).resolves.toEqual(expected)
    })

    it('ネットワーク例外を外へ投げず判定不能にする', async () => {
      fetchMock.mockRejectedValue(new Error('network error'))

      await expect(checkTwitchSubViaApi('user-1')).resolves.toEqual({
        hasSub: null,
        authError: false,
      })
    })

    it('broadcaster/user IDと認証ヘッダーをTwitch APIへ渡す', async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 })

      await checkTwitchSubViaApi('user-42')

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.twitch.tv/helix/subscriptions/user?broadcaster_id=broadcaster-123&user_id=user-42',
        {
          headers: {
            Authorization: 'Bearer test-token',
            'Client-Id': 'client-123',
          },
        }
      )
    })
  })
})
