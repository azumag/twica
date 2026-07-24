import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/gacha/demo/route'
import { getDb } from '@/lib/db/client'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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

const SAFE_CARD_ROW = {
  id: 'card-1',
  streamer_id: 'streamer-1',
  name: 'カード1',
  description: null,
  image_url: null,
  rarity: 'common',
  rarity_order: 4,
  drop_rate: 0.25,
  intra_rarity_weight: 1,
  max_issuance_count: null,
  collection_name: null,
  is_active: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

const MISSING_BATTLE_COLUMN_ERROR = {
  code: '42703',
  message: 'column "hp" of relation "cards" does not exist',
}

interface PgResponse {
  rows?: Array<Record<string, unknown>>
  error?: unknown
}

function createDrizzleDbMock(selects: PgResponse[]) {
  let selectIndex = 0
  const db = {
    select: vi.fn(() => {
      const response = selects[Math.min(selectIndex, selects.length - 1)] ?? { rows: [] }
      selectIndex += 1
      const resolve = () => response.error
        ? Promise.reject(response.error)
        : Promise.resolve(response.rows ?? [])
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

function primePgDb(selects: PgResponse[]) {
  const mock = createDrizzleDbMock(selects)
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any)
  return mock
}

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/gacha/demo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/gacha/demo: PlanetScale-only reads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fetches a requested card from PlanetScale', async () => {
    primePgDb([{ rows: [CARD_ROW] }])

    const response = await POST(request({ cardId: 'card-1' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.card.id).toBe('card-1')
    expect(getDb).toHaveBeenCalled()
  })

  it('selects an active streamer card', async () => {
    primePgDb([{ rows: [CARD_ROW] }])
    vi.spyOn(Math, 'random').mockReturnValue(0)

    const response = await POST(request({ streamerId: 'streamer-1' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.card.id).toBe('card-1')
  })

  it('falls back to a built-in demo card when PostgreSQL is unavailable', async () => {
    primePgDb([{ error: new Error('connection failure') }])

    const response = await POST(request({ cardId: 'missing' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.card).toBeDefined()
    expect(body.userTwitchUsername).toBe('DemoUser')
  })

  it('retries with CARDS_SAFE_COLUMNS when production-only battle columns are absent', async () => {
    const pg = primePgDb([
      { error: MISSING_BATTLE_COLUMN_ERROR },
      { rows: [SAFE_CARD_ROW] },
    ])

    const response = await POST(request({ cardId: 'card-1' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.card.id).toBe('card-1')
    expect(pg.db.select).toHaveBeenCalledTimes(2)
  })
})
