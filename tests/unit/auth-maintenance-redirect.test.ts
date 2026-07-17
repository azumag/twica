import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * #694 Stage 3: OAuth 系 GET route への guardWriteRedirect 個別挿入のテスト。
 *
 * 対象は /api/auth/twitch/callback・/api/auth/bot/callback・/api/auth/twitch/login。
 * いずれも GET だが書き込み副作用（user upsert・OAuth state cookie発行等）を
 * 持つため、middleware の一律ブロック（POST/PUT/PATCH/DELETEのみ対象）では
 * カバーされず、route 先頭で個別に guardWriteRedirect を呼ぶ設計になっている。
 *
 * 各 route の guardWriteRedirect 呼び出しは関数本体の最初の実行文であり、
 * ブロックされる場合は他の依存（rate limit・DB・Twitch API 等）を一切呼ばずに
 * 302 を返す。そのためこのテストは重い mock 構成を必要としない
 * （tests/setup.ts のグローバル mock（supabase/admin, db/client）だけで足りる）。
 *
 * mode=off での「従来挙動」の回帰確認は、このテストファイルではなく既存の
 * tests/unit/auth-scope-preservation.test.ts / auth-callback-driver-parity.test.ts
 * が担う（両ファイルとも MAINTENANCE_MODE を stub していないため常に off 相当で
 * 実行され、guard 挿入後もフルスイートが green であることがそのまま
 * 「off では挙動不変」の証拠になる）。
 */
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

const BLOCKED_MODES = ['read-only', 'cutover-validating', 'incident-read-only'] as const

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe.each(BLOCKED_MODES)('MAINTENANCE_MODE=%s のとき', (mode) => {
  beforeEach(() => {
    vi.stubEnv('MAINTENANCE_MODE', mode)
  })

  it('GET /api/auth/twitch/callback は /?maintenance=1 へ302リダイレクトする', async () => {
    const { GET } = await import('@/app/api/auth/twitch/callback/route')
    const request = new NextRequest('http://localhost:3000/api/auth/twitch/callback?code=x&state=y')
    const response = await GET(request)

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('/?maintenance=1')
  })

  it('GET /api/auth/bot/callback は /?maintenance=1 へ302リダイレクトする', async () => {
    const { GET } = await import('@/app/api/auth/bot/callback/route')
    const request = new NextRequest('http://localhost:3000/api/auth/bot/callback?code=x&state=y')
    const response = await GET(request)

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('/?maintenance=1')
  })

  it('GET /api/auth/twitch/login は /?maintenance=1 へ302リダイレクトする', async () => {
    const { GET } = await import('@/app/api/auth/twitch/login/route')
    const request = new Request('http://localhost:3000/api/auth/twitch/login')
    const response = await GET(request)

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('/?maintenance=1')
  })
})

describe('ブロックレスポンスのヘッダー', () => {
  beforeEach(() => {
    vi.stubEnv('MAINTENANCE_MODE', 'read-only')
  })

  it('Cache-Control: private, no-store を持つ（guardWriteRedirect再利用の確認）', async () => {
    const { GET } = await import('@/app/api/auth/twitch/callback/route')
    const request = new NextRequest('http://localhost:3000/api/auth/twitch/callback?code=x&state=y')
    const response = await GET(request)

    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })
})
