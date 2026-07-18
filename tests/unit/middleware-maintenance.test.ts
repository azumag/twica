import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { checkMaintenanceWriteBlock } from '@/middleware'

/**
 * src/middleware.ts の checkMaintenanceWriteBlock (#694 Stage 3) のテスト。
 *
 * 最重要の不変条件: MAINTENANCE_MODE 未設定（=off）のとき、middleware の
 * 追加処理によって挙動が一切変わらないこと。このテストファイルの
 * describe('mode=off 不変条件', ...) がその不変条件を直接検証する。
 *
 * middleware() 全体ではなく checkMaintenanceWriteBlock を直接テストする理由は
 * middleware.ts 側のコメント（同関数の export 理由）を参照。
 */
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

function makeRequest(method: string, pathname: string): NextRequest {
  return new NextRequest(`https://example.com${pathname}`, { method })
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('mode=off 不変条件', () => {
  it('MAINTENANCE_MODE 未設定なら /api への POST/PUT/PATCH/DELETE も全て素通し（null）', () => {
    vi.stubEnv('MAINTENANCE_MODE', undefined)
    expect(checkMaintenanceWriteBlock(makeRequest('POST', '/api/cards'))).toBeNull()
    expect(checkMaintenanceWriteBlock(makeRequest('PUT', '/api/cards/abc123'))).toBeNull()
    expect(checkMaintenanceWriteBlock(makeRequest('PATCH', '/api/cards/collections'))).toBeNull()
    expect(checkMaintenanceWriteBlock(makeRequest('DELETE', '/api/gacha-history/1'))).toBeNull()
  })

  it("MAINTENANCE_MODE='off' を明示しても全て素通し", () => {
    vi.stubEnv('MAINTENANCE_MODE', 'off')
    expect(checkMaintenanceWriteBlock(makeRequest('POST', '/api/cards'))).toBeNull()
    expect(checkMaintenanceWriteBlock(makeRequest('DELETE', '/api/twitch/eventsub/subscribe'))).toBeNull()
  })

  it('GET リクエストは mode に関わらず常に素通し（write block の対象外）', () => {
    vi.stubEnv('MAINTENANCE_MODE', 'read-only')
    expect(checkMaintenanceWriteBlock(makeRequest('GET', '/api/cards'))).toBeNull()
  })

  it('/api 以外のパスは書き込みメソッドでも常に素通し', () => {
    vi.stubEnv('MAINTENANCE_MODE', 'read-only')
    expect(checkMaintenanceWriteBlock(makeRequest('POST', '/dashboard/settings'))).toBeNull()
  })
})

describe('mode=read-only の一律ブロック', () => {
  beforeEach(() => {
    vi.stubEnv('MAINTENANCE_MODE', 'read-only')
  })

  it('allowlist未登録の書き込みは503でブロックされる', () => {
    const response = checkMaintenanceWriteBlock(makeRequest('POST', '/api/cards'))
    expect(response).not.toBeNull()
    expect(response!.status).toBe(503)
  })

  it('503レスポンスは Retry-After と Cache-Control: private, no-store を持つ（guardWrite再利用の確認）', () => {
    const response = checkMaintenanceWriteBlock(makeRequest('POST', '/api/cards'))!
    expect(response.headers.get('Retry-After')).toBeTruthy()
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('動的セグメントを持つルート（/api/cards/[id]）への PUT/DELETE もブロックされる', () => {
    expect(checkMaintenanceWriteBlock(makeRequest('PUT', '/api/cards/abc123'))!.status).toBe(503)
    expect(checkMaintenanceWriteBlock(makeRequest('DELETE', '/api/cards/abc123'))!.status).toBe(503)
  })

  it("allowlist の 'allow' エントリ（/api/auth/logout）は素通しする", () => {
    expect(checkMaintenanceWriteBlock(makeRequest('POST', '/api/auth/logout'))).toBeNull()
  })

  it("allowlist の 'queue-during-maintenance' エントリ（/api/twitch/eventsub）は素通しする", () => {
    expect(checkMaintenanceWriteBlock(makeRequest('POST', '/api/twitch/eventsub'))).toBeNull()
  })

  it('/api/twitch/eventsub の免除が兄弟ルート /api/twitch/eventsub/subscribe まで誤って広がらない（回帰テスト）', () => {
    const subscribeResponse = checkMaintenanceWriteBlock(makeRequest('POST', '/api/twitch/eventsub/subscribe'))
    expect(subscribeResponse).not.toBeNull()
    expect(subscribeResponse!.status).toBe(503)

    const debugResponse = checkMaintenanceWriteBlock(makeRequest('DELETE', '/api/twitch/eventsub/debug'))
    expect(debugResponse).not.toBeNull()
    expect(debugResponse!.status).toBe(503)
  })

  it('/api/admin/eventsub-replay（Issue #787）はallowlistで"block"登録されており、メンテ中は503でブロックされる（低-8）', () => {
    // config/maintenance-write-surfaces.json で maintenanceBehavior: "block" 登録済み。
    // メンテナンス解除後(mode=off)にのみ実行する運用のルートであり、
    // /api/twitch/eventsub（Webhook本体、queue-during-maintenance）とは異なり
    // 免除されないことをここで名指しして固定する。
    const response = checkMaintenanceWriteBlock(makeRequest('POST', '/api/admin/eventsub-replay'))
    expect(response).not.toBeNull()
    expect(response!.status).toBe(503)
  })
})

describe('mode=cutover-validating / incident-read-only でも一律ブロックが適用される', () => {
  it.each(['cutover-validating', 'incident-read-only'] as const)('mode=%s', (mode) => {
    vi.stubEnv('MAINTENANCE_MODE', mode)
    expect(checkMaintenanceWriteBlock(makeRequest('POST', '/api/cards'))!.status).toBe(503)
    expect(checkMaintenanceWriteBlock(makeRequest('POST', '/api/auth/logout'))).toBeNull()
  })
})
