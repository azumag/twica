/**
 * #788 子C #791: GET /api/auth/twitch/callback の
 *   1. channel_points_enabled フラグのセッションcookieへのミラーリング
 *      （PlanetScale/Drizzle 経路、列未デプロイ時のフォールバック含む）
 *   2. step-up再認証（isReauthFlow）直後・channel-pointsスコープ取得時のみ実行される
 *      Capability Probe の自動実行条件
 * に絞ったテスト。
 *
 * tests/unit/auth-callback-driver-parity.test.ts と同じモック idiom
 * （next/headers・@/lib/session・@/lib/twitch/auth・rate-limit・
 * auth-error-handler・logger・url-utils の vi.mock、および pg 経路用の
 * getDb() スタブ差し替え）を踏襲しつつ、このファイル固有の関心事
 * （@/lib/twitch/channel-points・@/lib/twitch/channel-points-access のモック）
 * を追加する。既存ファイルを肥大化させず関心を分離するため、独立ファイルとした。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { getDb } from '@/lib/db/client'
import { ADDITIONAL_SCOPES } from '@/lib/twitch/scopes'
import type { ChannelPointsCapabilityResult } from '@/lib/twitch/channel-points'

// next/headers: cookies() mock（driver-parity.test.ts と同一idiom）
const mockCookieStore = {
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
}
vi.mock('next/headers', () => ({
  cookies: vi.fn(() => Promise.resolve(mockCookieStore)),
}))

vi.mock('@/lib/session', () => ({
  signSession: (payload: string) => Promise.resolve(payload),
}))

vi.mock('@/lib/twitch/auth', () => ({
  getTwitchAuthUrl: vi.fn(() => 'https://twitch.tv/authorize'),
  exchangeCodeForTokens: vi.fn(),
  getTwitchUser: vi.fn(),
  isInvalidAuthorizationCodeError: vi.fn(() => false),
}))

const mockSaveTwitchScopes = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/twitch/token-manager', () => ({
  saveTwitchScopes: (...args: unknown[]) => mockSaveTwitchScopes(...args),
}))

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(() => Promise.resolve({ success: true, limit: 5, remaining: 4, reset: Date.now() + 60000 })),
  rateLimits: { authCallback: 'authCallback' },
  getClientIp: vi.fn(() => '127.0.0.1'),
}))

const mockHandleAuthError = vi.fn((...args: unknown[]) => {
  const [error, code] = args
  return {
    type: 'error',
    code,
    error,
    cookies: { set: vi.fn(), delete: vi.fn() },
    headers: { get: vi.fn() },
  }
})
vi.mock('@/lib/auth-error-handler', () => ({
  handleAuthError: (...args: unknown[]) => mockHandleAuthError(...args),
}))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/url-utils', () => ({
  getBaseUrl: vi.fn(() => 'http://localhost:3000'),
}))

// このファイル固有: Capability Probe / 永続化はテスト対象route自体の依存として
// モックし、呼び出しの有無・引数を直接アサートする。
const mockProbeChannelPointsCapability = vi.fn()
vi.mock('@/lib/twitch/channel-points', () => ({
  probeChannelPointsCapability: (...args: unknown[]) => mockProbeChannelPointsCapability(...args),
  // 実装と同じ判定ロジック（result.definitive === true）。route側の型ガード呼び出しを
  // モック環境でも動作させる（モジュール全体をvi.mockしているため実関数は使えない）。
  isDefinitiveCapabilityResult: (result: { definitive: boolean }) => result.definitive === true,
}))
const mockPersistChannelPointsCapability = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/twitch/channel-points-access', () => ({
  persistChannelPointsCapability: (...args: unknown[]) => mockPersistChannelPointsCapability(...args),
}))

/**
 * pg 直結経路 (Drizzle db) のモック。driver-parity.test.ts の
 * createDrizzleDbMock は select 呼び出し順(index)でレスポンスを切り替えるが、
 * このファイルは isReauthFlow の有無で select 呼び出し回数・順序が変わる
 * （既存スコープ乖離チェックの select が reauth flowでは走らない）ため、
 * 呼び出し順ではなく select する列名で判定する方が壊れにくい。
 */
function createPgDbMock(
  config: {
    existingScopes?: string[] | null
    tosAcceptedAt?: string | null
    channelPointsEnabled?: boolean | null
    channelPointsSelectError?: unknown
  } = {}
) {
  const {
    existingScopes = null,
    tosAcceptedAt = '2024-01-01',
    channelPointsEnabled = false,
    channelPointsSelectError = null,
  } = config

  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      const keys = Object.keys(fields)
      const builder: any = {
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        then: (onFulfilled: any, onRejected: any) => {
          let promise: Promise<unknown[]>
          if (keys.includes('twitch_scopes')) {
            promise = Promise.resolve(existingScopes !== null ? [{ twitch_scopes: existingScopes }] : [])
          } else if (keys.includes('channel_points_enabled')) {
            promise = channelPointsSelectError
              ? Promise.reject(channelPointsSelectError)
              : Promise.resolve(
                  channelPointsEnabled !== null ? [{ channel_points_enabled: channelPointsEnabled }] : []
                )
          } else if (keys.includes('tos_accepted_at')) {
            promise = Promise.resolve([{ tos_accepted_at: tosAcceptedAt }])
          } else {
            promise = Promise.resolve([])
          }
          return promise.then(onFulfilled, onRejected)
        },
      }
      return builder
    }),
    insert: vi.fn(() => {
      const builder: any = {
        values: vi.fn(() => builder),
        onConflictDoUpdate: vi.fn(() => builder),
        then: (onFulfilled: any) => Promise.resolve([{}]).then(onFulfilled),
      }
      return builder
    }),
  }
  return db
}

describe('GET /api/auth/twitch/callback: channel_points_enabled セッションミラーリング & step-up再認証Capability Probe (#788 子C #791)', () => {
  let exchangeCodeForTokens: ReturnType<typeof vi.fn>
  let getTwitchUser: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.clearAllMocks()
    mockSaveTwitchScopes.mockResolvedValue(undefined)
    mockPersistChannelPointsCapability.mockResolvedValue(undefined)

    const auth = await import('@/lib/twitch/auth')
    exchangeCodeForTokens = vi.mocked(auth.exchangeCodeForTokens)
    getTwitchUser = vi.mocked(auth.getTwitchUser)

    // 既定: 通常ログイン（REAUTH_STATEなし）
    mockCookieStore.get.mockImplementation((name: string) => {
      if (name === 'twitch_auth_state') return { value: 'test-state-123' }
      return undefined
    })

    exchangeCodeForTokens.mockResolvedValue({
      access_token: 'test-access-token',
      refresh_token: 'test-refresh-token',
      expires_in: 3600,
      token_type: 'bearer',
      scope: ['user:read:email'],
    })
    getTwitchUser.mockResolvedValue({
      id: 'user123',
      login: 'testuser',
      display_name: 'Test User',
      profile_image_url: 'https://example.com/avatar.png',
      broadcaster_type: 'affiliate',
    })
    vi.mocked(getDb).mockResolvedValue({ db: createPgDbMock(), sql: {} } as any)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function createCallbackRequest() {
    return new NextRequest('http://localhost:3000/api/auth/twitch/callback?code=test-code&state=test-state-123')
  }

  function setReauthCookies() {
    mockCookieStore.get.mockImplementation((name: string) => {
      if (name === 'twitch_auth_state') return { value: 'test-state-123' }
      if (name === 'twica_reauth_state') return { value: 'test-state-123' }
      return undefined
    })
  }

  async function runAndGetSessionData(response: Response) {
    const sessionCookie = (response as any).cookies.get('twica_session')
    expect(sessionCookie).toBeDefined()
    return JSON.parse(sessionCookie!.value)
  }

  describe('channel_points_enabled フラグのセッション反映', () => {
    it('channel_points_enabled列が未デプロイ(42703)でもログインは成功し、channelPointsEnabledはfalseにフォールバックする', async () => {
      // 42703 = undefined_column（postgres.js が投げるSQLSTATE形状のエラーを模擬）
      const missingColumnError = Object.assign(new Error('column "channel_points_enabled" does not exist'), {
        code: '42703',
      })
      const db = createPgDbMock({ channelPointsSelectError: missingColumnError })
      vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any)

      const { GET } = await import('@/app/api/auth/twitch/callback/route')
      const response = await GET(createCallbackRequest())

      // ログイン自体は失敗しない（database_errorに落ちていない）
      expect(mockHandleAuthError).not.toHaveBeenCalled()
      const sessionData = await runAndGetSessionData(response)
      expect(sessionData.channelPointsEnabled).toBe(false)
    })

    it('PlanetScale上でchannel_points_enabled=trueのとき、セッションのchannelPointsEnabledはtrue', async () => {
      const db = createPgDbMock({ channelPointsEnabled: true })
      vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any)

      const { GET } = await import('@/app/api/auth/twitch/callback/route')
      const response = await GET(createCallbackRequest())

      const sessionData = await runAndGetSessionData(response)
      expect(sessionData.channelPointsEnabled).toBe(true)
    })

    it('PlanetScale上でchannel_points_enabled=falseのとき、セッションのchannelPointsEnabledはfalse', async () => {
      vi.mocked(getDb).mockResolvedValue({
        db: createPgDbMock({ channelPointsEnabled: false }),
        sql: {},
      } as any)

      const { GET } = await import('@/app/api/auth/twitch/callback/route')
      const response = await GET(createCallbackRequest())

      const sessionData = await runAndGetSessionData(response)
      expect(sessionData.channelPointsEnabled).toBe(false)
    })
  })

  describe('step-up再認証時のCapability Probe自動実行', () => {
    it('通常ログイン（isReauthFlowがfalse）ではchannel:read:redemptionsスコープがあってもprobeChannelPointsCapabilityは呼ばれない', async () => {
      // REAUTH_STATE cookieなし（既定のbeforeEach設定のまま）= 通常ログイン
      exchangeCodeForTokens.mockResolvedValue({
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        expires_in: 3600,
        token_type: 'bearer',
        scope: ['user:read:email', ADDITIONAL_SCOPES.CHANNEL_READ_REDEMPTIONS],
      })
      const { GET } = await import('@/app/api/auth/twitch/callback/route')
      await GET(createCallbackRequest())

      expect(mockProbeChannelPointsCapability).not.toHaveBeenCalled()
    })

    it('step-up再認証（isReauthFlow）かつchannel:read:redemptionsスコープがある場合、probeChannelPointsCapabilityが呼ばれ、definitiveな結果はpersistChannelPointsCapabilityで保存される', async () => {
      setReauthCookies()
      exchangeCodeForTokens.mockResolvedValue({
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        expires_in: 3600,
        token_type: 'bearer',
        scope: ['user:read:email', ADDITIONAL_SCOPES.CHANNEL_READ_REDEMPTIONS],
      })
      const definitiveResult: ChannelPointsCapabilityResult = {
        capability: 'available',
        reason: 'ok',
        httpStatus: 200,
        definitive: true,
      }
      mockProbeChannelPointsCapability.mockResolvedValue(definitiveResult)
      const { GET } = await import('@/app/api/auth/twitch/callback/route')
      await GET(createCallbackRequest())

      expect(mockProbeChannelPointsCapability).toHaveBeenCalledWith('user123')
      expect(mockPersistChannelPointsCapability).toHaveBeenCalledWith('user123', definitiveResult)
    })

    it('step-up再認証（isReauthFlow）かつchannel:manage:redemptionsスコープがある場合もprobeChannelPointsCapabilityが呼ばれる', async () => {
      setReauthCookies()
      exchangeCodeForTokens.mockResolvedValue({
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        expires_in: 3600,
        token_type: 'bearer',
        scope: ['user:read:email', ADDITIONAL_SCOPES.CHANNEL_MANAGE_REDEMPTIONS],
      })
      mockProbeChannelPointsCapability.mockResolvedValue({
        capability: 'available',
        reason: 'ok',
        httpStatus: 200,
        definitive: true,
      })
      const { GET } = await import('@/app/api/auth/twitch/callback/route')
      await GET(createCallbackRequest())

      expect(mockProbeChannelPointsCapability).toHaveBeenCalledWith('user123')
    })

    it('step-up再認証でもchannel points系スコープがなければprobeChannelPointsCapabilityは呼ばれない', async () => {
      setReauthCookies()
      exchangeCodeForTokens.mockResolvedValue({
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        expires_in: 3600,
        token_type: 'bearer',
        scope: ['user:read:subscriptions'],
      })
      const { GET } = await import('@/app/api/auth/twitch/callback/route')
      await GET(createCallbackRequest())

      expect(mockProbeChannelPointsCapability).not.toHaveBeenCalled()
    })

    it('probeChannelPointsCapabilityがdefinitive:falseを返した場合、persistChannelPointsCapabilityは呼ばれず、ログインは通常通り成功する', async () => {
      setReauthCookies()
      exchangeCodeForTokens.mockResolvedValue({
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        expires_in: 3600,
        token_type: 'bearer',
        scope: ['user:read:email', ADDITIONAL_SCOPES.CHANNEL_READ_REDEMPTIONS],
      })
      mockProbeChannelPointsCapability.mockResolvedValue({
        capability: 'unknown',
        reason: 'rate_limited',
        httpStatus: 429,
        definitive: false,
      })
      const { GET } = await import('@/app/api/auth/twitch/callback/route')
      const response = await GET(createCallbackRequest())

      expect(mockProbeChannelPointsCapability).toHaveBeenCalledWith('user123')
      expect(mockPersistChannelPointsCapability).not.toHaveBeenCalled()
      expect(mockHandleAuthError).not.toHaveBeenCalled()
      await runAndGetSessionData(response)
    })

    it('probeChannelPointsCapabilityが例外を投げても、エラーは握りつぶされてログインは成功する', async () => {
      setReauthCookies()
      exchangeCodeForTokens.mockResolvedValue({
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        expires_in: 3600,
        token_type: 'bearer',
        scope: ['user:read:email', ADDITIONAL_SCOPES.CHANNEL_READ_REDEMPTIONS],
      })
      mockProbeChannelPointsCapability.mockRejectedValue(new Error('network down'))
      const { GET } = await import('@/app/api/auth/twitch/callback/route')
      const response = await GET(createCallbackRequest())

      expect(mockPersistChannelPointsCapability).not.toHaveBeenCalled()
      expect(mockHandleAuthError).not.toHaveBeenCalled()
      await runAndGetSessionData(response)
    })
  })
})
