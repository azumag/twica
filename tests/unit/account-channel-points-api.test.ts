import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { BROADCASTER_TYPE, COOKIE_NAMES, ERROR_MESSAGES } from '@/lib/constants'

// #791: GET/POST/PUT /api/account/channel-points のテスト。
// tests/unit/channel-point-bootstrap-api.test.ts / tests/unit/streamer-settings-api.test.ts
// と同じ慣習に従う: 各依存モジュールをvi.mockし、モック設定後にroute moduleを
// 動的importする（トップレベルでimportすると設定前に評価されてしまうため）。

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@/lib/session', () => ({
  getSession: vi.fn(),
  signSession: vi.fn(),
}))

vi.mock('@/lib/csrf', () => ({
  validateCSRFToken: vi.fn(),
}))

vi.mock('@/lib/request-validation', () => ({
  validateContentType: vi.fn(),
}))

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(),
  getRateLimitIdentifier: vi.fn(),
  rateLimits: { accountChannelPointsProbe: { windowMs: 60000, max: 10 } },
}))

// handleApiError: 本物はSentry記録を伴うため、他のroute testと同様に
// 最小限のNextResponse相当を返すモックに差し替える（このファイルのテストでは
// GET/POST/PUTのcatchブロックへ到達するケースを意図的に作っていない）。
vi.mock('@/lib/error-handler', () => ({
  handleApiError: vi.fn(() => NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })),
}))

vi.mock('@/lib/twitch/token-manager', () => ({
  hasScope: vi.fn(),
}))

vi.mock('@/lib/twitch/channel-points', () => ({
  probeChannelPointsCapability: vi.fn(),
  // 実装と同じ判定ロジック（result.definitive === true）。route側の型ガード呼び出しを
  // モック環境でも動作させる（モジュール全体をvi.mockしているため実関数は使えない）。
  isDefinitiveCapabilityResult: (result: { definitive: boolean }) => result.definitive === true,
}))

vi.mock('@/lib/twitch/channel-points-access', () => ({
  enableChannelPointsStreamerAccess: vi.fn(),
  getChannelPointsAccessState: vi.fn(),
  persistChannelPointsCapability: vi.fn(),
}))

const session = {
  twitchUserId: 'twitch-user-1',
  twitchUsername: 'testuser',
  twitchDisplayName: 'Test User',
  twitchProfileImageUrl: '',
  broadcasterType: BROADCASTER_TYPE.NONE,
  expiresAt: Date.now() + 60 * 60 * 1000,
  version: 1,
}

// signalを除外: lib.dom.d.tsのRequestInit.signalはAbortSignal | nullを許容するが、
// next/serverのNextRequest内部init型はAbortSignal | undefinedのみを受け付けるため
// 型不一致になる。このテストではsignalを使わないため型からも除外する。
type TestRequestInit = Omit<RequestInit, 'signal'>

function makeRequest(method: string, init?: TestRequestInit) {
  return new NextRequest('http://localhost:3000/api/account/channel-points', {
    method,
    ...init,
  })
}

function postRequest(init?: TestRequestInit) {
  return makeRequest('POST', {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function putRequest(init?: TestRequestInit) {
  return makeRequest('PUT', init)
}

describe('/api/account/channel-points', () => {
  beforeEach(async () => {
    vi.clearAllMocks()

    const { getSession, signSession } = await import('@/lib/session')
    const { validateCSRFToken } = await import('@/lib/csrf')
    const { validateContentType } = await import('@/lib/request-validation')
    const { checkRateLimit, getRateLimitIdentifier } = await import('@/lib/rate-limit')
    const { hasScope } = await import('@/lib/twitch/token-manager')
    const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
    const { getChannelPointsAccessState, persistChannelPointsCapability, enableChannelPointsStreamerAccess } =
      await import('@/lib/twitch/channel-points-access')

    // Sensible defaults so tests that don't care about a given dependency
    // don't have to configure it explicitly. Each test below overrides only
    // what it needs to exercise.
    vi.mocked(getSession).mockResolvedValue(session as any)
    vi.mocked(signSession).mockResolvedValue('signed-session-payload')
    vi.mocked(validateCSRFToken).mockResolvedValue({ valid: true })
    vi.mocked(validateContentType).mockReturnValue(null)
    vi.mocked(checkRateLimit).mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Date.now() + 60000,
    })
    vi.mocked(getRateLimitIdentifier).mockResolvedValue('user:twitch-user-1')
    vi.mocked(hasScope).mockResolvedValue(true)
    vi.mocked(getChannelPointsAccessState).mockResolvedValue({
      capability: 'unknown',
      checkedAt: null,
      enabled: false,
    })
    vi.mocked(persistChannelPointsCapability).mockResolvedValue(undefined)
    vi.mocked(enableChannelPointsStreamerAccess).mockResolvedValue({ ok: true, streamerId: 'streamer-1' })
    vi.mocked(probeChannelPointsCapability).mockResolvedValue({
      capability: 'unknown',
      reason: 'network_error',
      definitive: false,
    })
  })

  // ==========================================================================
  // GET
  // ==========================================================================
  describe('GET', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('#1 returns 401 when there is no session', async () => {
      const { getSession } = await import('@/lib/session')
      vi.mocked(getSession).mockResolvedValue(null)

      const { GET } = await import('@/app/api/account/channel-points/route')
      const response = await GET()

      expect(response.status).toBe(401)
      const body = await response.json()
      expect(body.error).toBe(ERROR_MESSAGES.UNAUTHORIZED)
    })

    it('#2 flags missing scope + stale + non-enabled for a fresh non-affiliate user', async () => {
      const { hasScope } = await import('@/lib/twitch/token-manager')
      const { getChannelPointsAccessState } = await import('@/lib/twitch/channel-points-access')
      vi.mocked(getChannelPointsAccessState).mockResolvedValue({
        capability: 'unknown',
        checkedAt: null,
        enabled: false,
      })
      vi.mocked(hasScope).mockResolvedValue(false)

      const { GET } = await import('@/app/api/account/channel-points/route')
      const response = await GET()
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body.hasRequiredScope).toBe(false)
      expect(body.requiresReauth).toBe(true)
      expect(body.stale).toBe(true)
      expect(body.canEnable).toBe(false)
    })

    it('#3 canEnable is true when available + scope present + not enabled + non-affiliate', async () => {
      const { hasScope } = await import('@/lib/twitch/token-manager')
      const { getChannelPointsAccessState } = await import('@/lib/twitch/channel-points-access')
      vi.mocked(getChannelPointsAccessState).mockResolvedValue({
        capability: 'available',
        checkedAt: new Date().toISOString(),
        enabled: false,
      })
      vi.mocked(hasScope).mockResolvedValue(true)

      const { GET } = await import('@/app/api/account/channel-points/route')
      const response = await GET()
      const body = await response.json()

      expect(body.canEnable).toBe(true)
    })

    it('#4 canEnable is false when already enabled', async () => {
      const { hasScope } = await import('@/lib/twitch/token-manager')
      const { getChannelPointsAccessState } = await import('@/lib/twitch/channel-points-access')
      vi.mocked(getChannelPointsAccessState).mockResolvedValue({
        capability: 'available',
        checkedAt: new Date().toISOString(),
        enabled: true,
      })
      vi.mocked(hasScope).mockResolvedValue(true)

      const { GET } = await import('@/app/api/account/channel-points/route')
      const response = await GET()
      const body = await response.json()

      expect(body.canEnable).toBe(false)
    })

    it('#5 canEnable is false for affiliates even when available and not enabled', async () => {
      const { getSession } = await import('@/lib/session')
      const { hasScope } = await import('@/lib/twitch/token-manager')
      const { getChannelPointsAccessState } = await import('@/lib/twitch/channel-points-access')
      vi.mocked(getSession).mockResolvedValue({ ...session, broadcasterType: BROADCASTER_TYPE.AFFILIATE } as any)
      vi.mocked(getChannelPointsAccessState).mockResolvedValue({
        capability: 'available',
        checkedAt: new Date().toISOString(),
        enabled: false,
      })
      vi.mocked(hasScope).mockResolvedValue(true)

      const { GET } = await import('@/app/api/account/channel-points/route')
      const response = await GET()
      const body = await response.json()

      expect(body.canEnable).toBe(false)
    })

    it('#6a stale is true when capabilityCheckedAt is more than 24h old', async () => {
      vi.useFakeTimers()
      const now = new Date('2026-07-23T00:00:00.000Z')
      vi.setSystemTime(now)

      const { hasScope } = await import('@/lib/twitch/token-manager')
      const { getChannelPointsAccessState } = await import('@/lib/twitch/channel-points-access')
      vi.mocked(hasScope).mockResolvedValue(true)
      vi.mocked(getChannelPointsAccessState).mockResolvedValue({
        capability: 'available',
        // Exactly threshold + 1ms ago: Date.now() - checkedAtMs > 24h is true.
        checkedAt: new Date(now.getTime() - 24 * 60 * 60 * 1000 - 1).toISOString(),
        enabled: false,
      })

      const { GET } = await import('@/app/api/account/channel-points/route')
      const response = await GET()
      const body = await response.json()

      expect(body.stale).toBe(true)
    })

    it('#6b stale is false at the exact 24h boundary (isStale uses strictly-greater-than)', async () => {
      vi.useFakeTimers()
      const now = new Date('2026-07-23T00:00:00.000Z')
      vi.setSystemTime(now)

      const { hasScope } = await import('@/lib/twitch/token-manager')
      const { getChannelPointsAccessState } = await import('@/lib/twitch/channel-points-access')
      vi.mocked(hasScope).mockResolvedValue(true)
      vi.mocked(getChannelPointsAccessState).mockResolvedValue({
        capability: 'available',
        // Exactly 24h ago: Date.now() - checkedAtMs === 24h, and `>` is strict,
        // so this boundary is NOT stale per src/app/api/account/channel-points/route.ts isStale().
        checkedAt: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
        enabled: false,
      })

      const { GET } = await import('@/app/api/account/channel-points/route')
      const response = await GET()
      const body = await response.json()

      expect(body.stale).toBe(false)
    })

    it('#6c stale is false when capabilityCheckedAt is less than 24h old', async () => {
      vi.useFakeTimers()
      const now = new Date('2026-07-23T00:00:00.000Z')
      vi.setSystemTime(now)

      const { hasScope } = await import('@/lib/twitch/token-manager')
      const { getChannelPointsAccessState } = await import('@/lib/twitch/channel-points-access')
      vi.mocked(hasScope).mockResolvedValue(true)
      vi.mocked(getChannelPointsAccessState).mockResolvedValue({
        capability: 'available',
        checkedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
        enabled: false,
      })

      const { GET } = await import('@/app/api/account/channel-points/route')
      const response = await GET()
      const body = await response.json()

      expect(body.stale).toBe(false)
    })

    it('#7 requiresReauth is true when capability is reauth_required even if hasRequiredScope is true', async () => {
      const { hasScope } = await import('@/lib/twitch/token-manager')
      const { getChannelPointsAccessState } = await import('@/lib/twitch/channel-points-access')
      vi.mocked(hasScope).mockResolvedValue(true)
      vi.mocked(getChannelPointsAccessState).mockResolvedValue({
        capability: 'reauth_required',
        checkedAt: new Date().toISOString(),
        enabled: false,
      })

      const { GET } = await import('@/app/api/account/channel-points/route')
      const response = await GET()
      const body = await response.json()

      expect(body.hasRequiredScope).toBe(true)
      expect(body.requiresReauth).toBe(true)
    })

    it('#8 defaults capability to unknown and does not crash when there is no DB row', async () => {
      const { hasScope } = await import('@/lib/twitch/token-manager')
      const { getChannelPointsAccessState } = await import('@/lib/twitch/channel-points-access')
      vi.mocked(hasScope).mockResolvedValue(true)
      vi.mocked(getChannelPointsAccessState).mockResolvedValue(null)

      const { GET } = await import('@/app/api/account/channel-points/route')
      const response = await GET()
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body.capability).toBe('unknown')
      expect(body.capabilityCheckedAt).toBeNull()
      expect(body.enabled).toBe(false)
    })
  })

  // ==========================================================================
  // POST
  // ==========================================================================
  describe('POST', () => {
    it('#9 returns 403 and never checks the rate limit when CSRF is invalid', async () => {
      const { validateCSRFToken } = await import('@/lib/csrf')
      const { checkRateLimit } = await import('@/lib/rate-limit')
      vi.mocked(validateCSRFToken).mockResolvedValue({ valid: false })

      const { POST } = await import('@/app/api/account/channel-points/route')
      const response = await POST(postRequest())
      const body = await response.json()

      expect(response.status).toBe(403)
      expect(body.error).toBe(ERROR_MESSAGES.FORBIDDEN)
      expect(checkRateLimit).not.toHaveBeenCalled()
    })

    it('#10 returns the content-type validation response directly', async () => {
      const { validateContentType } = await import('@/lib/request-validation')
      const { validateCSRFToken } = await import('@/lib/csrf')
      const sentinel = NextResponse.json({ error: 'unsupported media type' }, { status: 415 })
      vi.mocked(validateContentType).mockReturnValue(sentinel)

      const { POST } = await import('@/app/api/account/channel-points/route')
      const response = await POST(postRequest())

      expect(response).toBe(sentinel)
      expect(validateCSRFToken).not.toHaveBeenCalled()
    })

    it('#11 returns 429 when rate limited', async () => {
      const { checkRateLimit } = await import('@/lib/rate-limit')
      vi.mocked(checkRateLimit).mockResolvedValue({
        success: false,
        limit: 10,
        remaining: 0,
        reset: Date.now() + 60000,
      })

      const { POST } = await import('@/app/api/account/channel-points/route')
      const response = await POST(postRequest())
      const body = await response.json()

      expect(response.status).toBe(429)
      expect(body.error).toBe(ERROR_MESSAGES.RATE_LIMIT_EXCEEDED)
    })

    it('#12 returns 401 when there is no session', async () => {
      const { getSession } = await import('@/lib/session')
      vi.mocked(getSession).mockResolvedValue(null)

      const { POST } = await import('@/app/api/account/channel-points/route')
      const response = await POST(postRequest())

      expect(response.status).toBe(401)
    })

    it('#13 persists reauth_required and skips the Twitch probe when scope is missing', async () => {
      const { hasScope } = await import('@/lib/twitch/token-manager')
      const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
      const { persistChannelPointsCapability, getChannelPointsAccessState } =
        await import('@/lib/twitch/channel-points-access')
      vi.mocked(hasScope).mockResolvedValue(false)
      vi.mocked(getChannelPointsAccessState).mockResolvedValue({
        capability: 'reauth_required',
        checkedAt: '2026-07-22T00:00:00.000Z',
        enabled: false,
      })

      const { POST } = await import('@/app/api/account/channel-points/route')
      const response = await POST(postRequest())
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body.code).toBe('reauth_required')
      expect(persistChannelPointsCapability).toHaveBeenCalledWith('twitch-user-1', {
        capability: 'reauth_required',
        reason: 'no_access_token',
        definitive: true,
      })
      expect(probeChannelPointsCapability).not.toHaveBeenCalled()
    })

    it('#14 persists a definitive available probe result and echoes the freshly persisted state', async () => {
      const { hasScope } = await import('@/lib/twitch/token-manager')
      const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
      const { persistChannelPointsCapability, getChannelPointsAccessState } =
        await import('@/lib/twitch/channel-points-access')
      vi.mocked(hasScope).mockResolvedValue(true)
      const probeResult = { capability: 'available', reason: 'ok', httpStatus: 200, definitive: true }
      vi.mocked(probeChannelPointsCapability).mockResolvedValue(probeResult as any)
      vi.mocked(getChannelPointsAccessState).mockResolvedValue({
        capability: 'available',
        checkedAt: '2026-07-23T00:00:00.000Z',
        enabled: false,
      })

      const { POST } = await import('@/app/api/account/channel-points/route')
      const response = await POST(postRequest())
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(persistChannelPointsCapability).toHaveBeenCalledWith('twitch-user-1', probeResult)
      expect(body.code).toBe('available')
      expect(body.persisted).toEqual({
        capability: 'available',
        capabilityCheckedAt: '2026-07-23T00:00:00.000Z',
      })
      expect(body.enabled).toBe(false)
    })

    it('#15 does not persist a non-definitive probe result and returns the unchanged existing state', async () => {
      const { hasScope } = await import('@/lib/twitch/token-manager')
      const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
      const { persistChannelPointsCapability, getChannelPointsAccessState } =
        await import('@/lib/twitch/channel-points-access')
      vi.mocked(hasScope).mockResolvedValue(true)
      // A 429 from Twitch: not definitive, must not clobber existing confirmed DB state.
      const probeResult = { capability: 'unknown', reason: 'rate_limited', httpStatus: 429, definitive: false }
      vi.mocked(probeChannelPointsCapability).mockResolvedValue(probeResult as any)
      const existingState = {
        capability: 'available' as const,
        checkedAt: '2025-01-01T00:00:00.000Z',
        enabled: false,
      }
      vi.mocked(getChannelPointsAccessState).mockResolvedValue(existingState)

      const { POST } = await import('@/app/api/account/channel-points/route')
      const response = await POST(postRequest())
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(persistChannelPointsCapability).not.toHaveBeenCalled()
      expect(body.code).toBe('probe_temporarily_failed')
      // The persisted state reflects the PRE-EXISTING (unchanged) DB row, proving
      // the transient probe failure did not overwrite it.
      expect(body.persisted).toEqual({
        capability: 'available',
        capabilityCheckedAt: '2025-01-01T00:00:00.000Z',
      })
    })
  })

  // ==========================================================================
  // PUT
  // ==========================================================================
  describe('PUT', () => {
    it('#16 returns 401 when there is no session', async () => {
      const { getSession } = await import('@/lib/session')
      vi.mocked(getSession).mockResolvedValue(null)

      const { PUT } = await import('@/app/api/account/channel-points/route')
      const response = await PUT(putRequest())

      expect(response.status).toBe(401)
    })

    it('#17 returns 403 when CSRF is invalid', async () => {
      const { validateCSRFToken } = await import('@/lib/csrf')
      vi.mocked(validateCSRFToken).mockResolvedValue({ valid: false })

      const { PUT } = await import('@/app/api/account/channel-points/route')
      const response = await PUT(putRequest())
      const body = await response.json()

      expect(response.status).toBe(403)
      expect(body.error).toBe(ERROR_MESSAGES.FORBIDDEN)
    })

    it('#18 returns 429 when rate limited', async () => {
      const { checkRateLimit } = await import('@/lib/rate-limit')
      vi.mocked(checkRateLimit).mockResolvedValue({
        success: false,
        limit: 10,
        remaining: 0,
        reset: Date.now() + 60000,
      })

      const { PUT } = await import('@/app/api/account/channel-points/route')
      const response = await PUT(putRequest())
      const body = await response.json()

      expect(response.status).toBe(429)
      expect(body.error).toBe(ERROR_MESSAGES.RATE_LIMIT_EXCEEDED)
    })

    it.each([BROADCASTER_TYPE.AFFILIATE, BROADCASTER_TYPE.PARTNER])(
      '#19 returns already_enabled immediately for existing %s streamers without probing or enabling',
      async (broadcasterType) => {
        const { getSession } = await import('@/lib/session')
        const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
        const { enableChannelPointsStreamerAccess } = await import('@/lib/twitch/channel-points-access')
        vi.mocked(getSession).mockResolvedValue({ ...session, broadcasterType } as any)

        const { PUT } = await import('@/app/api/account/channel-points/route')
        const response = await PUT(putRequest())
        const body = await response.json()

        expect(response.status).toBe(200)
        expect(body).toEqual({ code: 'already_enabled', enabled: true })
        expect(probeChannelPointsCapability).not.toHaveBeenCalled()
        expect(enableChannelPointsStreamerAccess).not.toHaveBeenCalled()
      }
    )

    it('#20 returns reauth_required (409) and persists it without probing or enabling when scope is missing', async () => {
      const { hasScope } = await import('@/lib/twitch/token-manager')
      const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
      const { persistChannelPointsCapability, enableChannelPointsStreamerAccess } =
        await import('@/lib/twitch/channel-points-access')
      vi.mocked(hasScope).mockResolvedValue(false)

      const { PUT } = await import('@/app/api/account/channel-points/route')
      const response = await PUT(putRequest())
      const body = await response.json()

      expect(response.status).toBe(409)
      expect(body).toEqual({ code: 'reauth_required', enabled: false })
      expect(persistChannelPointsCapability).toHaveBeenCalledWith('twitch-user-1', {
        capability: 'reauth_required',
        reason: 'no_access_token',
        definitive: true,
      })
      expect(probeChannelPointsCapability).not.toHaveBeenCalled()
      expect(enableChannelPointsStreamerAccess).not.toHaveBeenCalled()
    })

    it('#21 returns channel_points_unavailable (409) and does not enable when a fresh probe says unavailable', async () => {
      const { hasScope } = await import('@/lib/twitch/token-manager')
      const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
      const { enableChannelPointsStreamerAccess } = await import('@/lib/twitch/channel-points-access')
      vi.mocked(hasScope).mockResolvedValue(true)
      vi.mocked(probeChannelPointsCapability).mockResolvedValue({
        capability: 'unavailable',
        reason: 'forbidden',
        httpStatus: 403,
        definitive: true,
      } as any)

      const { PUT } = await import('@/app/api/account/channel-points/route')
      const response = await PUT(putRequest())
      const body = await response.json()

      expect(response.status).toBe(409)
      expect(body.code).toBe('channel_points_unavailable')
      expect(body.enabled).toBe(false)
      expect(enableChannelPointsStreamerAccess).not.toHaveBeenCalled()
    })

    // 自動レビュー(claude[bot])指摘: #21のunavailableに加え、reauth_required /
    // probe_temporarily_failed へのcodeマッピングも回帰検知対象にする。
    it('#21b returns reauth_required (409) and does not enable when a fresh probe says reauth_required', async () => {
      const { hasScope } = await import('@/lib/twitch/token-manager')
      const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
      const { enableChannelPointsStreamerAccess } = await import('@/lib/twitch/channel-points-access')
      vi.mocked(hasScope).mockResolvedValue(true)
      vi.mocked(probeChannelPointsCapability).mockResolvedValue({
        capability: 'reauth_required',
        reason: 'unauthorized',
        httpStatus: 401,
        definitive: true,
      } as any)

      const { PUT } = await import('@/app/api/account/channel-points/route')
      const response = await PUT(putRequest())
      const body = await response.json()

      expect(response.status).toBe(409)
      expect(body.code).toBe('reauth_required')
      expect(body.enabled).toBe(false)
      expect(enableChannelPointsStreamerAccess).not.toHaveBeenCalled()
    })

    it('#21c returns probe_temporarily_failed (409) and does not enable when a fresh probe is non-definitive (e.g. 429)', async () => {
      const { hasScope } = await import('@/lib/twitch/token-manager')
      const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
      const { enableChannelPointsStreamerAccess, persistChannelPointsCapability } =
        await import('@/lib/twitch/channel-points-access')
      vi.mocked(hasScope).mockResolvedValue(true)
      vi.mocked(probeChannelPointsCapability).mockResolvedValue({
        capability: 'unknown',
        reason: 'rate_limited',
        httpStatus: 429,
        definitive: false,
      } as any)

      const { PUT } = await import('@/app/api/account/channel-points/route')
      const response = await PUT(putRequest())
      const body = await response.json()

      expect(response.status).toBe(409)
      expect(body.code).toBe('probe_temporarily_failed')
      expect(body.enabled).toBe(false)
      expect(enableChannelPointsStreamerAccess).not.toHaveBeenCalled()
      // definitive=falseの結果を確定状態として保存してはならない
      expect(persistChannelPointsCapability).not.toHaveBeenCalled()
    })

    it('#22 always re-probes rather than trusting a stale DB state: a live "available" probe triggers enable', async () => {
      // Deliberately do NOT configure getChannelPointsAccessState to say
      // 'available' here (it defaults to 'unknown' via the shared beforeEach,
      // and PUT never even reads it) — the fresh probeChannelPointsCapability
      // mock below is the only thing driving enablement, proving the route
      // does not trust any possibly-stale DB row.
      const { hasScope } = await import('@/lib/twitch/token-manager')
      const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
      const { enableChannelPointsStreamerAccess } = await import('@/lib/twitch/channel-points-access')
      vi.mocked(hasScope).mockResolvedValue(true)
      vi.mocked(probeChannelPointsCapability).mockResolvedValue({
        capability: 'available',
        reason: 'ok',
        httpStatus: 200,
        definitive: true,
      } as any)
      vi.mocked(enableChannelPointsStreamerAccess).mockResolvedValue({ ok: true, streamerId: 'streamer-1' })

      const { PUT } = await import('@/app/api/account/channel-points/route')
      const response = await PUT(putRequest())

      expect(probeChannelPointsCapability).toHaveBeenCalledWith('twitch-user-1')
      expect(enableChannelPointsStreamerAccess).toHaveBeenCalledWith('twitch-user-1')
      expect(response.status).toBe(200)
    })

    it('#23 sets the session cookie and returns enabled:true when the probe and enable both succeed', async () => {
      const { hasScope } = await import('@/lib/twitch/token-manager')
      const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
      const { enableChannelPointsStreamerAccess } = await import('@/lib/twitch/channel-points-access')
      const { signSession } = await import('@/lib/session')
      vi.mocked(hasScope).mockResolvedValue(true)
      vi.mocked(probeChannelPointsCapability).mockResolvedValue({
        capability: 'available',
        reason: 'ok',
        httpStatus: 200,
        definitive: true,
      } as any)
      vi.mocked(enableChannelPointsStreamerAccess).mockResolvedValue({ ok: true, streamerId: 'uuid-1' })
      vi.mocked(signSession).mockResolvedValue('signed-cookie-value')

      const { PUT } = await import('@/app/api/account/channel-points/route')
      const response = await PUT(putRequest())
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body).toEqual({ code: 'enabled', enabled: true, streamerId: 'uuid-1' })
      expect(response.cookies.get(COOKIE_NAMES.SESSION)?.value).toBe('signed-cookie-value')
    })

    it('#24 returns channel_points_unavailable (409) with no cookie when enable fails with capability_not_available', async () => {
      const { hasScope } = await import('@/lib/twitch/token-manager')
      const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
      const { enableChannelPointsStreamerAccess } = await import('@/lib/twitch/channel-points-access')
      vi.mocked(hasScope).mockResolvedValue(true)
      vi.mocked(probeChannelPointsCapability).mockResolvedValue({
        capability: 'available',
        reason: 'ok',
        httpStatus: 200,
        definitive: true,
      } as any)
      vi.mocked(enableChannelPointsStreamerAccess).mockResolvedValue({
        ok: false,
        error: 'capability_not_available',
      })

      const { PUT } = await import('@/app/api/account/channel-points/route')
      const response = await PUT(putRequest())
      const body = await response.json()

      expect(response.status).toBe(409)
      expect(body).toEqual({ code: 'channel_points_unavailable', enabled: false })
      expect(response.cookies.get(COOKIE_NAMES.SESSION)).toBeUndefined()
    })

    it('#25 returns user_not_found (409) with no cookie when enable fails with user_not_found', async () => {
      const { hasScope } = await import('@/lib/twitch/token-manager')
      const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
      const { enableChannelPointsStreamerAccess } = await import('@/lib/twitch/channel-points-access')
      vi.mocked(hasScope).mockResolvedValue(true)
      vi.mocked(probeChannelPointsCapability).mockResolvedValue({
        capability: 'available',
        reason: 'ok',
        httpStatus: 200,
        definitive: true,
      } as any)
      vi.mocked(enableChannelPointsStreamerAccess).mockResolvedValue({
        ok: false,
        error: 'user_not_found',
      })

      const { PUT } = await import('@/app/api/account/channel-points/route')
      const response = await PUT(putRequest())
      const body = await response.json()

      expect(response.status).toBe(409)
      expect(body).toEqual({ code: 'user_not_found', enabled: false })
      expect(response.cookies.get(COOKIE_NAMES.SESSION)).toBeUndefined()
    })

    it('#26 double-submit: two sequential successful PUT calls both return the same enabled shape', async () => {
      const { hasScope } = await import('@/lib/twitch/token-manager')
      const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
      const { enableChannelPointsStreamerAccess } = await import('@/lib/twitch/channel-points-access')
      vi.mocked(hasScope).mockResolvedValue(true)
      vi.mocked(probeChannelPointsCapability).mockResolvedValue({
        capability: 'available',
        reason: 'ok',
        httpStatus: 200,
        definitive: true,
      } as any)
      vi.mocked(enableChannelPointsStreamerAccess).mockResolvedValue({ ok: true, streamerId: 'streamer-1' })

      const { PUT } = await import('@/app/api/account/channel-points/route')
      const first = await PUT(putRequest())
      const firstBody = await first.json()
      const second = await PUT(putRequest())
      const secondBody = await second.json()

      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      expect(firstBody).toEqual({ code: 'enabled', enabled: true, streamerId: 'streamer-1' })
      expect(secondBody).toEqual({ code: 'enabled', enabled: true, streamerId: 'streamer-1' })
    })

    it('#27 reports session_resync_failed (500) but still enabled:true when the DB write succeeded but signSession throws', async () => {
      const { hasScope } = await import('@/lib/twitch/token-manager')
      const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
      const { enableChannelPointsStreamerAccess } = await import('@/lib/twitch/channel-points-access')
      const { signSession } = await import('@/lib/session')
      vi.mocked(hasScope).mockResolvedValue(true)
      vi.mocked(probeChannelPointsCapability).mockResolvedValue({
        capability: 'available',
        reason: 'ok',
        httpStatus: 200,
        definitive: true,
      } as any)
      vi.mocked(enableChannelPointsStreamerAccess).mockResolvedValue({ ok: true, streamerId: 'streamer-1' })
      vi.mocked(signSession).mockRejectedValue(new Error('signing key unavailable'))

      const { PUT } = await import('@/app/api/account/channel-points/route')
      const response = await PUT(putRequest())
      const body = await response.json()

      expect(response.status).toBe(500)
      expect(body.code).toBe('session_resync_failed')
      // DB write already succeeded, so the client must still be told enabled:true
      // even though the session cookie could not be refreshed.
      expect(body.enabled).toBe(true)
      expect(response.cookies.get(COOKIE_NAMES.SESSION)).toBeUndefined()
    })

    it('#28 never validates content-type / reads a body — targeting is session-only', async () => {
      const { validateContentType } = await import('@/lib/request-validation')
      const { hasScope } = await import('@/lib/twitch/token-manager')
      const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
      const { enableChannelPointsStreamerAccess } = await import('@/lib/twitch/channel-points-access')
      vi.mocked(hasScope).mockResolvedValue(true)
      vi.mocked(probeChannelPointsCapability).mockResolvedValue({
        capability: 'available',
        reason: 'ok',
        httpStatus: 200,
        definitive: true,
      } as any)
      vi.mocked(enableChannelPointsStreamerAccess).mockResolvedValue({ ok: true, streamerId: 'streamer-1' })

      const { PUT } = await import('@/app/api/account/channel-points/route')
      // No content-type header and no body at all — this must not trigger a
      // content-type validation failure, because PUT never calls validateContentType.
      const response = await PUT(putRequest())

      expect(response.status).toBe(200)
      expect(validateContentType).not.toHaveBeenCalled()
    })
  })
})
