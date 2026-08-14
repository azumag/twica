import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { POST } from '@/app/api/gacha/demo/route'
import { getDb } from '@/lib/db/client'
import { cards as cardsTable } from '@/lib/db/schema'

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

interface PgResponse {
  rows?: Array<Record<string, unknown>>
  error?: unknown
}

function createDrizzleDbMock(selects: PgResponse[]) {
  let selectIndex = 0
  const whereConditions: unknown[] = []
  const db = {
    select: vi.fn(() => {
      const response = selects[Math.min(selectIndex, selects.length - 1)] ?? { rows: [] }
      selectIndex += 1
      const resolve = () => response.error
        ? Promise.reject(response.error)
        : Promise.resolve(response.rows ?? [])
      const builder: any = {
        from: vi.fn(() => builder),
        where: vi.fn((condition: unknown) => {
          whereConditions.push(condition)
          return builder
        }),
        limit: vi.fn(() => builder),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
  }
  return { db, whereConditions }
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

    // #735: cardId指定の単一カード取得はstreamerId必須(下記の専用テスト参照)
    const response = await POST(request({ cardId: 'card-1', streamerId: 'streamer-1' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.card.id).toBe('card-1')
    expect(getDb).toHaveBeenCalled()
  })

  it('selects an active streamer card', async () => {
    primePgDb([{ rows: [CARD_ROW] }])
    // 単一カードプールなので crypto 乱数の値は結果に影響しない（0で固定）
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((buf) => {
      if (buf instanceof Uint32Array && buf.length >= 1) {
        buf[0] = 0
      }
      return buf
    })

    const response = await POST(request({ streamerId: 'streamer-1' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.card.id).toBe('card-1')
  })

  it('falls back to a built-in demo card when PostgreSQL is unavailable', async () => {
    primePgDb([{ error: new Error('connection failure') }])

    const response = await POST(request({ cardId: 'missing', streamerId: 'streamer-1' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.card).toBeDefined()
    expect(body.userTwitchUsername).toBe('DemoUser')
    expect(getDb).toHaveBeenCalled()
  })

  it('#735: cardId指定時はis_active=trueかつ指定streamerId配下に絞り込む', async () => {
    const pg = primePgDb([{ rows: [CARD_ROW] }])

    const response = await POST(request({ cardId: 'card-1', streamerId: 'streamer-1' }))

    expect(response.status).toBe(200)
    expect(pg.whereConditions[0]).toEqual(
      and(
        eq(cardsTable.id, 'card-1'),
        eq(cardsTable.streamer_id, 'streamer-1'),
        eq(cardsTable.is_active, true)
      )
    )
  })

  it('#735: streamerId未指定時はcardIdによる単一カード取得を一切試みない(他streamerのactiveカードを無認証で引ける横断オラクル化を防ぐ)', async () => {
    const pg = primePgDb([{ rows: [CARD_ROW] }])

    const response = await POST(request({ cardId: 'card-1' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    // DBへの問い合わせが一切発生しない(streamerId無しではcardId検索もstreamer別
    // ランダム取得も走らないため、組み込みDEMO_CARDSへ直接フォールバックする)
    expect(pg.db.select).not.toHaveBeenCalled()
    expect(body.card.id).not.toBe('card-1')
  })

  it('#735: 絞り込みでヒットしない場合(非公開カード等)はエラーにせず組み込みデモカードへフォールバックする', async () => {
    primePgDb([{ rows: [] }])

    const response = await POST(request({ cardId: 'inactive-or-foreign-card', streamerId: 'streamer-1' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.card).toBeDefined()
    expect(body.card.id).not.toBe('inactive-or-foreign-card')
  })
})
