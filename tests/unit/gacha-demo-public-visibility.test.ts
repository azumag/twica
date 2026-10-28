import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { POST } from '@/app/api/gacha/demo/route'
import { getDb } from '@/lib/db/client'
import { getSession } from '@/lib/session'
import { getStreamerIdByTwitchUserId } from '@/lib/user-data'
import { validateCSRFToken } from '@/lib/csrf'
import { checkRateLimit, getRateLimitIdentifier } from '@/lib/rate-limit'
import { createOverlayDemoEvent } from '@/lib/overlay/demo-event-store'

/**
 * /api/gacha/demo の無認証経路は、配信者が未所持カードの公開
 * （show_unowned_cards と show_unowned_card_details の両方）を許可している場合に
 * だけ実カードを返し、返す列もオーバーレイ表示に必要な6項目に限る。
 *
 * 回帰テストの対象: 以前は公開設定を見ずに streamerId だけで is_active=true の
 * 全カードを db.select() の全列（drop_rate / max_issuance_count 等を含む）で
 * 無認証レスポンスに載せていた。
 *
 * 公開設定の判定は SQL（streamers との JOIN 条件）で行うため、モックDBでは条件を
 * 評価できない。ここでは (1) 組み立てた SQL 条件・JOIN・SELECT 列を検査し、
 * (2) DB が「条件に合う行なし」を返したときの組み込みデモカードへの縮退と、
 * (3) レスポンスの列の絞り込みを検査する。
 */
vi.mock('@/lib/logger.server', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/session')
vi.mock('@/lib/user-data')
vi.mock('@/lib/csrf')
vi.mock('@/lib/overlay/demo-event-store', () => ({
  createOverlayDemoEvent: vi.fn(),
  storeOverlayDemoEvent: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/overlay-realtime/publisher', () => ({
  publishOverlayDemoRealtimeEvent: vi.fn().mockResolvedValue({ outcome: 'accepted', attempts: 1 }),
}))
vi.mock('@/lib/background-task', () => ({
  runInBackground: vi.fn(async (_label: string, task: Promise<unknown>) => {
    await task
  }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(),
  getRateLimitIdentifier: vi.fn(),
  rateLimits: { gachaDemoBroadcast: {}, gachaDemoCard: {} },
  retryAfterSeconds: vi.fn(),
}))
vi.mock('@/lib/db/client', () => ({ getDb: vi.fn() }))

/** DB が返し得る「全列入り」の行（非公開情報を含む）。 */
const FULL_ROW = {
  id: 'card-1',
  streamer_id: 'streamer-1',
  name: 'カード1',
  description: '説明',
  image_url: 'https://example.com/a.png',
  image_padding_color: '#112233',
  rarity: 'rare',
  rarity_order: 3,
  drop_rate: 0.25,
  intra_rarity_weight: 1,
  card_number: 7,
  max_issuance_count: 100,
  collection_name: 'secret-collection',
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

/** オーバーレイ（overlay/[streamerId]/page.tsx）が実際に参照するカード項目。 */
const OVERLAY_FIELDS = ['description', 'id', 'image_padding_color', 'image_url', 'name', 'rarity']

function primeDb(rows: Array<Record<string, unknown>>) {
  const captured = {
    selectArgs: [] as unknown[],
    where: [] as unknown[],
    joins: 0,
  }
  const db = {
    select: vi.fn((fields?: unknown) => {
      captured.selectArgs.push(fields)
      const builder: any = {
        from: vi.fn(() => builder),
        innerJoin: vi.fn(() => {
          captured.joins += 1
          return builder
        }),
        where: vi.fn((condition: unknown) => {
          captured.where.push(condition)
          return builder
        }),
        limit: vi.fn(() => builder),
        then: (ok: any, ng: any) => Promise.resolve(rows).then(ok, ng),
      }
      return builder
    }),
  }
  vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any)
  return captured
}

function renderWhere(condition: unknown): { sql: string; params: unknown[] } {
  return new PgDialect().sqlToQuery(condition as SQL)
}

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/gacha/demo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/gacha/demo: 無認証経路の公開設定と返却列', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(checkRateLimit).mockResolvedValue({ success: true, limit: 30, remaining: 29, reset: Date.now() + 60_000 })
    vi.mocked(getRateLimitIdentifier).mockResolvedValue('ip:test')
    vi.mocked(validateCSRFToken).mockResolvedValue({ valid: true })
    vi.mocked(createOverlayDemoEvent).mockImplementation((card) => ({
      id: 'demo:1',
      eventId: 'demo:1',
      redeemedAt: '2026-01-01T00:00:00.000Z',
      userTwitchUsername: 'DemoUser',
      rewardId: null,
      card: { ...card, image_padding_color: card.image_padding_color ?? null },
    }) as ReturnType<typeof createOverlayDemoEvent>)
  })

  it('無認証（ランダム）: streamers.show_unowned_cards / show_unowned_card_details の両方 true を JOIN 条件に含める', async () => {
    const captured = primeDb([FULL_ROW])

    await POST(request({ streamerId: 'streamer-1' }))

    expect(captured.joins).toBe(1)
    const { sql, params } = renderWhere(captured.where[0])
    expect(sql).toContain('"streamers"."show_unowned_cards" = $')
    expect(sql).toContain('"streamers"."show_unowned_card_details" = $')
    expect(sql).toContain('"cards"."is_active" = $')
    expect(sql).toContain('"cards"."streamer_id" = $')
    // 公開設定の比較値は true（false を許す条件ではない）
    expect(params.filter((p) => p === true)).toHaveLength(3) // is_active + 公開設定2つ
  })

  it('無認証（cardId 指定）でも同じ公開設定の条件が付く', async () => {
    const captured = primeDb([FULL_ROW])

    await POST(request({ streamerId: 'streamer-1', cardId: 'card-1' }))

    expect(captured.joins).toBe(1)
    const { sql } = renderWhere(captured.where[0])
    expect(sql).toContain('"cards"."id" = $')
    expect(sql).toContain('"streamers"."show_unowned_cards" = $')
    expect(sql).toContain('"streamers"."show_unowned_card_details" = $')
  })

  it('公開設定を満たさず該当行なし（DBが空を返す）の場合は、組み込みデモカードを返し実カードIDを含めない', async () => {
    primeDb([])

    for (const body of [{ streamerId: 'streamer-1' }, { streamerId: 'streamer-1', cardId: 'card-1' }]) {
      const response = await POST(request(body))
      const json = await response.json()

      expect(response.status).toBe(200)
      expect(json.card.name).toContain('デモカード')
      expect(json.card.id).not.toBe('card-1')
      expect(Object.keys(json.card).sort()).toEqual(OVERLAY_FIELDS)
    }
  })

  it('db.select() は全列ではなく表示に必要な6列だけを指定する', async () => {
    const captured = primeDb([FULL_ROW])

    await POST(request({ streamerId: 'streamer-1' }))

    const selected = captured.selectArgs[0] as Record<string, unknown> | undefined
    expect(selected).toBeDefined()
    expect(Object.keys(selected!).sort()).toEqual(OVERLAY_FIELDS)
  })

  it('DB が全列入りの行を返しても、レスポンスの card は表示用6項目だけ（drop_rate / max_issuance_count 等を含まない）', async () => {
    primeDb([FULL_ROW])

    for (const body of [{ streamerId: 'streamer-1' }, { streamerId: 'streamer-1', cardId: 'card-1' }]) {
      const response = await POST(request(body))
      const json = await response.json()

      expect(response.status).toBe(200)
      expect(json.card).toEqual({
        id: 'card-1',
        name: 'カード1',
        description: '説明',
        image_url: 'https://example.com/a.png',
        image_padding_color: '#112233',
        rarity: 'rare',
      })
      expect(json.card).not.toHaveProperty('drop_rate')
      expect(json.card).not.toHaveProperty('max_issuance_count')
      expect(json.card).not.toHaveProperty('streamer_id')
      expect(json.userTwitchUsername).toBe('DemoUser')
    }
  })

  it('組み込みデモカード（streamerId なし）もオーバーレイが使う全項目を持つ（デモ表示が壊れない）', async () => {
    const captured = primeDb([])

    const response = await POST(request({}))
    const json = await response.json()

    expect(captured.selectArgs).toHaveLength(0)
    expect(Object.keys(json.card).sort()).toEqual(OVERLAY_FIELDS)
    expect(typeof json.card.id).toBe('string')
    expect(typeof json.card.name).toBe('string')
    expect(typeof json.card.rarity).toBe('string')
  })

  it('broadcast（ログイン中の配信者本人）は従来どおり公開設定に関係なく実カードを返す', async () => {
    const captured = primeDb([FULL_ROW])
    vi.mocked(getSession).mockResolvedValue({
      twitchUserId: 'twitch-1',
      twitchUsername: 'user1',
      broadcasterType: 'affiliate',
    } as Awaited<ReturnType<typeof getSession>>)
    vi.mocked(getStreamerIdByTwitchUserId).mockResolvedValue({ id: 'streamer-1' })

    const response = await POST(request({ streamerId: 'streamer-1', cardId: 'card-1', broadcast: true }))
    const json = await response.json()

    expect(response.status).toBe(200)
    // 公開設定の JOIN / 条件は付かない
    expect(captured.joins).toBe(0)
    expect(renderWhere(captured.where[0]).sql).not.toContain('show_unowned')
    expect(json.card.id).toBe('card-1')
    expect(json.card.name).toBe('カード1')
    // broadcast でも返す列は表示用6項目のみ
    expect(Object.keys(json.card).sort()).toEqual(OVERLAY_FIELDS)
    // KV / DO へ流すイベントにも実カードが渡る
    expect(vi.mocked(createOverlayDemoEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'card-1', name: 'カード1' })
    )
  })
})
