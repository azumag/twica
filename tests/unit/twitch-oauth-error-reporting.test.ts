/**
 * OAuth 失敗を下位層と HTTP 境界の双方で errors テーブルへ書くと、error reporter が
 * 同じ障害から複数の Issue を作成する。このテストは実際の auth/token-manager/error
 * handler を通し、永続 writer がリクエストごとに一度だけであることを固定する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const mocks = vi.hoisted(() => ({
  cookieGet: vi.fn(),
  cookieSet: vi.fn(),
  getSession: vi.fn(),
  canUseStreamerFeatures: vi.fn(),
  checkRateLimit: vi.fn(),
  getRateLimitIdentifier: vi.fn(),
  getSupabaseAdmin: vi.fn(),
  reportAuthError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}))

vi.mock('next/headers', () => ({
  cookies: vi.fn(() => Promise.resolve({ get: mocks.cookieGet, set: mocks.cookieSet, delete: vi.fn() })),
}))
vi.mock('@/lib/supabase/admin', () => ({ getSupabaseAdmin: mocks.getSupabaseAdmin }))
vi.mock('@/lib/session', () => ({
  getSession: mocks.getSession,
  canUseStreamerFeatures: mocks.canUseStreamerFeatures,
  signSession: vi.fn(async (value: string) => value),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  getRateLimitIdentifier: mocks.getRateLimitIdentifier,
  getClientIp: vi.fn(() => '127.0.0.1'),
  rateLimits: { authCallback: {}, twitchRewardsGet: {} },
}))
vi.mock('@/lib/sentry/error-handler', () => ({
  reportAuthError: mocks.reportAuthError,
  logErrorFromLogger: mocks.logErrorFromLogger,
  reportError: vi.fn(),
  reportApiError: vi.fn(),
}))
vi.mock('@/lib/url-utils', () => ({ getBaseUrl: vi.fn(() => 'http://localhost:3000') }))
vi.mock('@/lib/maintenance/guard', () => ({ guardWriteRedirect: vi.fn(() => null) }))
vi.mock('@/lib/twitch/linked-account-auth', () => ({ handleLinkedAccountCallback: vi.fn() }))

import { GET as callbackGet } from '@/app/api/auth/twitch/callback/route'
import { GET as loginGet } from '@/app/api/auth/twitch/login/route'
import { GET as rewardsGet } from '@/app/api/twitch/rewards/route'
import { GET as bootstrapGet } from '@/app/api/twitch/channel-point-bootstrap/route'

it('token-managerはrequest-scoped I/Oをmodule-scope Mapへ保持しない', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/lib/twitch/token-manager.ts'),
    'utf8',
  )
  // Workers isolateは複数requestで再利用される。module-scope Mapを許すと、将来
  // pending Promise以外の名前へ変えてもrequest-scoped I/O共有が再発し得るため、
  // このtoken管理モジュールでは用途を限定せずmodule-scope Map自体を禁止する。
  const moduleScopeMap = source.match(
    /^(?:export\s+)?(?:const|let|var)\s+\w+(?:\s*:[^=\n]+)?\s*=\s*new\s+Map\b/gm,
  )

  expect(moduleScopeMap).toBeNull()
  expect(source).not.toMatch(/(?:SingleFlight|RefreshFlights)/)
})

const SECRET = 'SECRET_SENTINEL_TOKEN_ENDPOINT_BODY'
const CODE = 'SECRET_SENTINEL_AUTHORIZATION_CODE'

function userTokenQuery() {
  const query: Record<string, ReturnType<typeof vi.fn>> = {
    select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(), from: vi.fn(), update: vi.fn(),
  }
  query.select.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  query.maybeSingle.mockResolvedValue({
    data: {
      twitch_access_token: 'expired-access-token',
      twitch_refresh_token: 'expired-refresh-token',
      twitch_token_expires_at: new Date(Date.now() - 60_000).toISOString(),
    },
    error: null,
  })
  return query
}

function scopeThenExpiredTokenQuery() {
  const query: Record<string, ReturnType<typeof vi.fn>> = {
    select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(), from: vi.fn(), update: vi.fn(),
  }
  query.select.mockImplementation((columns: string) => {
    query.maybeSingle.mockResolvedValue(columns === 'twitch_scopes'
      ? { data: { twitch_scopes: ['channel:read:redemptions'] }, error: null }
      : { data: {
        twitch_access_token: 'expired-access-token',
        twitch_refresh_token: 'expired-refresh-token',
        twitch_token_expires_at: new Date(Date.now() - 60_000).toISOString(),
      }, error: null })
    return query
  })
  query.eq.mockReturnValue(query)
  return query
}

function allPersistedArguments(): string {
  return JSON.stringify([
    ...mocks.reportAuthError.mock.calls,
    ...mocks.logErrorFromLogger.mock.calls,
  ])
}

describe('OAuth error reporting has exactly one durable writer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_TWITCH_CLIENT_ID = 'public-client-id'
    process.env.TWITCH_CLIENT_SECRET = 'server-secret'
    mocks.checkRateLimit.mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: Date.now() + 60_000 })
    mocks.getRateLimitIdentifier.mockResolvedValue('test-rate-limit-key')
    mocks.cookieGet.mockImplementation((name: string) => name === 'twitch_auth_state' ? { value: 'state-1' } : undefined)
  })

  it('login route の失敗もhandleAuthErrorだけが一度記録する', async () => {
    mocks.checkRateLimit.mockRejectedValueOnce(new Error('login rate-limit backend failed'))

    const response = await loginGet(new Request('http://localhost:3000/api/auth/twitch/login'))

    expect(response.status).toBe(500)
    expect(mocks.reportAuthError).toHaveBeenCalledTimes(1)
    expect(mocks.logErrorFromLogger).not.toHaveBeenCalled()
  })

  it('callback の 522 token exchange は reportAuthError だけに一度記録し、code/body を渡さない', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(SECRET, { status: 522 })
    )
    try {
      const response = await callbackGet(new NextRequest(`http://localhost:3000/api/auth/twitch/callback?code=${CODE}&state=state-1`))

      // NextResponse.redirect の既定 status は 307。ここでは redirect 種別ではなく、
      // exchange failure が callback 境界まで到達したことだけを確認する。
      expect(response.status).toBe(307)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(mocks.reportAuthError).toHaveBeenCalledTimes(1)
      expect(mocks.logErrorFromLogger).not.toHaveBeenCalled()
      const serialized = allPersistedArguments()
      expect(serialized).not.toContain(SECRET)
      expect(serialized).not.toContain(CODE)
    } finally {
      fetchMock.mockRestore()
    }
  })

  it('callback の2xx不正token JSONも本文を捨てて一度だけ記録する', async () => {
    const malformedSecret = 'SECRET_MALFORMED_CALLBACK_BODY'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(`{"access_token":"${malformedSecret}"`, { status: 200 })
    )
    try {
      const response = await callbackGet(new NextRequest(`http://localhost:3000/api/auth/twitch/callback?code=${CODE}&state=state-1`))

      expect(response.status).toBe(307)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(mocks.reportAuthError).toHaveBeenCalledTimes(1)
      expect(mocks.logErrorFromLogger).not.toHaveBeenCalled()
      const serialized = allPersistedArguments()
      expect(serialized).not.toContain(malformedSecret)
      expect(serialized).not.toContain(CODE)
    } finally {
      fetchMock.mockRestore()
    }
  })

  it('期限切れ token の 522 refresh は rewards API 境界で一度だけ記録し、provider body を渡さない', async () => {
    mocks.getSession.mockResolvedValue({ twitchUserId: 'streamer-1' })
    mocks.canUseStreamerFeatures.mockReturnValue(true)
    const query = userTokenQuery()
    mocks.getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => query) })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(SECRET, { status: 522 }))
    try {
      const response = await rewardsGet(new Request('http://localhost:3000/api/twitch/rewards'))

      expect(response.status).toBe(500)
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(mocks.reportAuthError).not.toHaveBeenCalled()
      expect(mocks.logErrorFromLogger).toHaveBeenCalledTimes(1)
      expect(allPersistedArguments()).not.toContain(SECRET)
    } finally {
      fetchMock.mockRestore()
    }
  }, 10_000)

  it('期限切れtokenの2xx不正refresh JSONもrewards境界で本文を捨てて一度だけ記録する', async () => {
    const malformedSecret = 'SECRET_MALFORMED_REFRESH_BODY'
    mocks.getSession.mockResolvedValue({ twitchUserId: 'streamer-1' })
    mocks.canUseStreamerFeatures.mockReturnValue(true)
    const query = userTokenQuery()
    mocks.getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => query) })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(`{"refresh_token":"${malformedSecret}"`, { status: 200 })
    )
    try {
      const response = await rewardsGet(new Request('http://localhost:3000/api/twitch/rewards'))

      expect(response.status).toBe(500)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(mocks.reportAuthError).not.toHaveBeenCalled()
      expect(mocks.logErrorFromLogger).toHaveBeenCalledTimes(1)
      expect(allPersistedArguments()).not.toContain(malformedSecret)
    } finally {
      fetchMock.mockRestore()
    }
  })

  it('期限切れ token の 522 refresh は bootstrap API 境界でも一度だけ記録する', async () => {
    mocks.getSession.mockResolvedValue({ twitchUserId: 'streamer-1' })
    mocks.canUseStreamerFeatures.mockReturnValue(true)
    mocks.getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => scopeThenExpiredTokenQuery()) })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(SECRET, { status: 522 }))
    try {
      const response = await bootstrapGet(new NextRequest('http://localhost:3000/api/twitch/channel-point-bootstrap'))

      expect(response.status).toBe(500)
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(mocks.reportAuthError).not.toHaveBeenCalled()
      expect(mocks.logErrorFromLogger).toHaveBeenCalledTimes(1)
      expect(allPersistedArguments()).not.toContain(SECRET)
    } finally {
      fetchMock.mockRestore()
    }
  }, 10_000)
})
