/**
 * #663 (Batch A): GET /api/streamer/[streamerId]/sound-settings の
 * postgrest 経路 / pg 経路の互換テスト。
 *
 * tests/unit/sound-settings-api.test.ts のモック方法を踏襲しつつ、両経路の
 * 戻り値・エラーフォールバック・列未デプロイ(PGRST204/42703)フォールバックを
 * 突き合わせる（announcements-driver-parity.test.ts と同じ流儀）。
 *
 * 読み取り専用のパブリックエンドポイントのため isPgReadEnabled() で分岐
 * （DB_DRIVER=pg-read でも pg 経路）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '@/app/api/streamer/[streamerId]/sound-settings/route'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { getDb } from '@/lib/db/client'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const mockGetSupabaseAdmin = vi.mocked(getSupabaseAdmin)

function request(streamerId = 'streamer-1') {
  return new NextRequest(`http://localhost:3000/api/streamer/${streamerId}/sound-settings`)
}

function run(streamerId: string, driver: string | undefined) {
  vi.stubEnv('DB_DRIVER', driver)
  return GET(request(streamerId), { params: Promise.resolve({ streamerId }) })
}

// ---------------------------------------------------------------------------
// postgrest 経路のモック（sound-settings-api.test.ts と同形式）
// ---------------------------------------------------------------------------

function createSoundSettingsClient(response: {
  data: { gacha_sound_url: string | null; gacha_sound_enabled: boolean | null; gacha_sound_rules?: unknown } | null
  error: { message: string; code?: string } | null
}) {
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(response),
  }
  return { from: vi.fn(() => query), query }
}

// ---------------------------------------------------------------------------
// pg 経路のモック
// ---------------------------------------------------------------------------

function createDrizzleDbMock(config: {
  selects?: Array<{ rows?: Array<Record<string, unknown>>; error?: unknown }>
} = {}) {
  let selectIndex = 0
  const selectCalls: Array<{ fields: Record<string, unknown> }> = []
  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      selectCalls.push({ fields })
      const responses = config.selects ?? [{ rows: [] }]
      const response = responses[Math.min(selectIndex, responses.length - 1)]
      selectIndex += 1
      const resolve = () =>
        response.error
          ? Promise.reject(response.error)
          : Promise.resolve(
              (response.rows ?? []).map((row) =>
                Object.fromEntries(Object.keys(fields).map((key) => [key, row[key] ?? null]))
              )
            )
      const builder: any = {
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
  }
  return { db, selectCalls }
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any)
}

describe('GET /api/streamer/[streamerId]/sound-settings（読み取り専用: DB_DRIVER=pg-read でも pg 経路）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('設定済みの効果音を返す: 両経路の戻り値が一致する', async () => {
    const client = createSoundSettingsClient({
      data: { gacha_sound_url: 'https://cdn.example.com/sound.mp3', gacha_sound_enabled: true, gacha_sound_rules: [] },
      error: null,
    })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await run('streamer-1', undefined)
    const postgrestBody = await postgrestRes.json()

    const pg = createDrizzleDbMock({
      selects: [{ rows: [{ gacha_sound_url: 'https://cdn.example.com/sound.mp3', gacha_sound_enabled: true, gacha_sound_rules: [] }] }],
    })
    primePgDb(pg)
    const pgRes = await run('streamer-1', 'pg-read')
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)
    expect(pgBody).toEqual({
      soundUrl: 'https://cdn.example.com/sound.mp3',
      soundEnabled: true,
      soundRules: [
        expect.objectContaining({ targetType: 'all', url: 'https://cdn.example.com/sound.mp3', enabled: true }),
      ],
    })
  })

  it('配信者が存在しない（0行）: 両経路とも 404 STREAMER_NOT_FOUND', async () => {
    const client = createSoundSettingsClient({ data: null, error: null })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await run('missing-streamer', undefined)

    const pg = createDrizzleDbMock({ selects: [{ rows: [] }] })
    primePgDb(pg)
    const pgRes = await run('missing-streamer', 'pg-read')

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(404)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
  })

  it('取得失敗時: 両経路ともログ + { soundUrl: null, soundEnabled: false } の 200 応答にフェイルセーフする', async () => {
    const client = createSoundSettingsClient({ data: null, error: { message: 'error code: 520' } })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await run('streamer-1', undefined)
    const postgrestBody = await postgrestRes.json()

    const pg = createDrizzleDbMock({ selects: [{ error: { code: '08006', message: 'connection failure' } }] })
    primePgDb(pg)
    const pgRes = await run('streamer-1', 'pg-read')
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)
    expect(pgBody).toEqual({ soundUrl: null, soundEnabled: false })
    expect(logger.warn).toHaveBeenCalledWith(
      'Streamer Sound Settings API: falling back to disabled sound settings',
      expect.objectContaining({ streamerId: 'streamer-1' })
    )
  })

  it('gacha_sound_rules 列未デプロイ(PGRST204相当): 両経路とも旧列にフォールバックし gacha_sound_rules: [] を補完する', async () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi
        .fn()
        .mockResolvedValueOnce({
          data: null,
          error: { code: 'PGRST204', message: "Could not find the 'gacha_sound_rules' column" },
        })
        .mockResolvedValueOnce({
          data: { gacha_sound_url: 'https://cdn.example.com/legacy.mp3', gacha_sound_enabled: true },
          error: null,
        }),
    }
    mockGetSupabaseAdmin.mockReturnValue({ from: vi.fn(() => query) } as any)
    const postgrestRes = await run('streamer-1', undefined)
    const postgrestBody = await postgrestRes.json()

    // pg 経路: 1回目の SELECT（3列）が 42703 で失敗 → 2回目（2列のみ）が成功
    const pg = createDrizzleDbMock({
      selects: [
        { error: { code: '42703', message: 'column "gacha_sound_rules" does not exist' } },
        { rows: [{ gacha_sound_url: 'https://cdn.example.com/legacy.mp3', gacha_sound_enabled: true }] },
      ],
    })
    primePgDb(pg)
    const pgRes = await run('streamer-1', 'pg-read')
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)
    expect(pgBody.soundUrl).toBe('https://cdn.example.com/legacy.mp3')
    expect(pg.selectCalls).toHaveLength(2)
    expect(Object.keys(pg.selectCalls[0].fields)).toEqual([
      'gacha_sound_url',
      'gacha_sound_enabled',
      'gacha_sound_rules',
    ])
    expect(Object.keys(pg.selectCalls[1].fields)).toEqual(['gacha_sound_url', 'gacha_sound_enabled'])
  })

  it('フラグ未設定時は getDb が一切呼ばれない（挙動不変の検証）', async () => {
    const client = createSoundSettingsClient({
      data: { gacha_sound_url: null, gacha_sound_enabled: false, gacha_sound_rules: [] },
      error: null,
    })
    mockGetSupabaseAdmin.mockReturnValue(client as any)

    await run('streamer-1', undefined)
    expect(getDb).not.toHaveBeenCalled()
  })
})
