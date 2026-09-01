import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { middleware } from '@/middleware'

const { updateSessionMock } = vi.hoisted(() => ({
  updateSessionMock: vi.fn(
    async () => new Response(null, { status: 200 })
  ),
}))

/**
 * middleware の fail-closed Cache-Control デフォルト（#906）のテスト。
 *
 * Workers Cache 有効化後、Cache-Control 未設定の GET が heuristics でキャッシュ
 * される事故を防ぐため、middleware が「明示的にキャッシュ許可した公開パス以外」
 * に private, no-store を付与することを検証する。
 */
vi.mock('@/lib/session-middleware', () => ({
  updateSession: updateSessionMock,
}))

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ success: true, limit: 1000, remaining: 999, reset: Date.now() + 60000 }),
  getClientIp: vi.fn(() => '127.0.0.1'),
  rateLimits: { global: {} },
}))

vi.mock('@/lib/security-headers', () => ({
  setSecurityHeaders: (response: Response) => response,
  buildCsp: (nonce?: string) => nonce ? `default-src 'self'; script-src 'self' 'nonce-${nonce}'` : `default-src 'self'; script-src 'self'`,
}))

// maintenance-status はキャッシュ許可パスのため、middleware が no-store を付けず、
// ルート側の Cache-Control を維持することを確認するために使う。
const CACHEABLE_PUBLIC_PATH = '/api/maintenance-status'

function makeRequest(pathname: string): NextRequest {
  return new NextRequest(`https://example.com${pathname}`, { method: 'GET' })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('middleware fail-closed Cache-Control (issue #906)', () => {
  it('キャッシュ許可パス以外の API に private, no-store を付与する', async () => {
    const response = await middleware(makeRequest('/api/some-private-endpoint'))
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('キャッシュ許可パス（/api/maintenance-status）には no-store を付与しない', async () => {
    const response = await middleware(makeRequest(CACHEABLE_PUBLIC_PATH))
    // ルート側で設定する public ヘッダーを middleware が上書きしないこと。
    // （このテストでは updateSession がヘッダーを設定しないため、Cache-Control は
    // 未設定のまま = ルート側の設定が生きる）
    expect(response.headers.get('Cache-Control')).toBeNull()
  })

  it('キャッシュ許可パス（/api/overlay/ 配下の realtime-config）にも no-store を付与しない', async () => {
    const response = await middleware(makeRequest('/api/overlay/123e4567-e89b-42d3-a456-426614174000/realtime-config'))
    expect(response.headers.get('Cache-Control')).toBeNull()
  })

  it('overlay events（3秒間隔ポーリング・Cache-Control 未設定）には private, no-store を付与する', async () => {
    // /api/overlay/ の prefix 許可だと events が Workers Caching のヒューリスティック
    // TTL（200 → 2時間）でキャッシュされてしまうため、エンドポイント単位の
    // 絞り込み（realtime-config のみ）を固定する回帰テスト。
    const response = await middleware(makeRequest('/api/overlay/123e4567-e89b-42d3-a456-426614174000/events'))
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('不正 streamerId の overlay events 400 にも private, no-store を付与する', async () => {
    const response = await middleware(makeRequest('/api/overlay/not-a-uuid/events'))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Invalid streamer ID' })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    // DB/session I/O より前の早期拒否契約も維持する。
    expect(updateSessionMock).not.toHaveBeenCalled()
  })

  it('overlay demo-events にも private, no-store を付与する（ルート側 no-store と二重防御）', async () => {
    const response = await middleware(makeRequest('/api/overlay/123e4567-e89b-42d3-a456-426614174000/demo-events'))
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('ページルートにも private, no-store を付与する（トップページ以外）', async () => {
    const response = await middleware(makeRequest('/guide'))
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('request ヘッダーに x-nonce と CSP を積む（layout との nonce 契約、#836）', async () => {
    await middleware(makeRequest('/guide'))
    const [, requestHeaders] = updateSessionMock.mock.calls[0] as unknown as [unknown, Headers]
    const nonce = requestHeaders.get('x-nonce')
    expect(nonce).toBeTruthy()
    // buildCsp モックは nonce を CSP へ埋め込むため、同じ nonce が CSP に含まれること
    expect(requestHeaders.get('Content-Security-Policy')).toContain(`nonce-${nonce}`)
  })
})
