/**
 * #663: 低頻度APIルート群のpg直結移行 — POST /api/gacha/demo の
 * postgrest経路 / pg経路パリティテスト
 *
 * このルートは他の対象ルートと異なり getSupabaseAdmin() を使わず
 * createClient(supabaseUrl, supabaseKey) でアドホックなクライアントを生成する
 * （公開デモエンドポイントのため）。pg 経路は supabaseUrl/supabaseKey の設定
 * 有無に依存しないことも検証する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { getDb } from '@/lib/db/client'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/realtime', () => ({
  broadcastGachaResult: vi.fn(() => Promise.resolve()),
}))

const CARD_ROW = {
  id: 'card-1',
  streamer_id: 'streamer-1',
  name: 'カード1',
  description: null,
  image_url: null,
  rarity: 'common',
  rarity_order: 4,
  drop_rate: 0.25,
  intra_rarity_weight: 1,
  card_number: null,
  max_issuance_count: null,
  collection_name: null,
  is_active: true,
  hp: 100,
  atk: 30,
  def: 15,
  spd: 5,
  skill_type: 'attack',
  skill_name: '通常攻撃',
  skill_power: 10,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

interface PgResponse {
  rows?: Array<Record<string, unknown>>
  error?: unknown
}

function createDrizzleDbMock(config: { selects?: PgResponse[] } = {}) {
  let selectIndex = 0
  const db = {
    select: vi.fn(() => {
      const responses = config.selects ?? [{ rows: [] }]
      const response = responses[Math.min(selectIndex, responses.length - 1)]
      selectIndex += 1
      const resolve = () => (response.error ? Promise.reject(response.error) : Promise.resolve(response.rows ?? []))
      const builder: any = {
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
  }
  return { db }
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any)
}

function createRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/gacha/demo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/gacha/demo: postgrest / pg 経路の互換 (#663)', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    process.env = { ...originalEnv }
  })

  it('フラグ未設定時は getDb が呼ばれない（挙動不変の検証。cardIdでカードが見つかる場合）', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    vi.doMock('@supabase/supabase-js', () => ({
      createClient: vi.fn(() => ({
        from: vi.fn(() => ({
          select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue({ data: CARD_ROW, error: null }) })) })),
        })),
      })),
    }))

    const { POST } = await import('@/app/api/gacha/demo/route')
    const response = await POST(createRequest({ cardId: 'card-1' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.card.id).toBe('card-1')
    expect(getDb).not.toHaveBeenCalled()
    vi.doUnmock('@supabase/supabase-js')
  })

  it('DB_DRIVER=pg-read: cardId指定時、pg経路でカードが取得される', async () => {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ selects: [{ rows: [CARD_ROW] }] })
    primePgDb(pg)

    const { POST } = await import('@/app/api/gacha/demo/route')
    const response = await POST(createRequest({ cardId: 'card-1' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.card.id).toBe('card-1')
    expect(getDb).toHaveBeenCalled()
  })

  it('DB_DRIVER=pg-read: streamerId指定時、pg経路でアクティブカードからランダム選択される', async () => {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ selects: [{ rows: [CARD_ROW] }] })
    primePgDb(pg)

    const { POST } = await import('@/app/api/gacha/demo/route')
    const response = await POST(createRequest({ streamerId: 'streamer-1' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.card.streamer_id).toBe('streamer-1')
    expect(getDb).toHaveBeenCalled()
  })

  it('DB_DRIVER=pg-read: pg経路が失敗してもデモカードにフォールバックする（既存の安全側フォールバック挙動を維持）', async () => {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ selects: [{ error: new Error('connection failure') }] })
    primePgDb(pg)

    const { POST } = await import('@/app/api/gacha/demo/route')
    const response = await POST(createRequest({ cardId: 'nonexistent' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.card).toBeDefined()
    expect(body.userTwitchUsername).toBe('DemoUser')
  })

  it('DB_DRIVER=pg-read: supabaseUrl/supabaseKey が未設定でもpg経路は動作する（アドホッククライアント非依存の検証）', async () => {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    delete process.env.SUPABASE_SECRET_KEY
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    const pg = createDrizzleDbMock({ selects: [{ rows: [CARD_ROW] }] })
    primePgDb(pg)

    const { POST } = await import('@/app/api/gacha/demo/route')
    const response = await POST(createRequest({ cardId: 'card-1' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.card.id).toBe('card-1')
    expect(getDb).toHaveBeenCalled()
  })
})
