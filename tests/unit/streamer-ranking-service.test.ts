/**
 * 匿名ランキング読み取り層 (src/lib/services/streamer-ranking.ts, Issue #742 子B)
 *
 * 検証対象は「1文で DB 関数を呼ぶこと」「contract への正規化」「デプロイ窓の縮退」
 * 「contract が食い違ったときに黙って流さないこと」。
 * ランキングの中身（匿名性・順位・近傍）は実 PostgreSQL の fixture
 * (tests/fixtures/streamer-ranking-read-postgres.sql) が検証する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), sql: vi.fn() }))
vi.mock('@/lib/db/client', () => ({ getDb: mocks.getDb }))
vi.mock('@/lib/db/retry', () => ({
  withDbRetry: async <T>(fn: () => Promise<T>) => fn(),
}))
import {
  getStreamerRanking,
  normalizeStreamerRankingPayload,
  STREAMER_RANKING_SCHEMA_VERSION,
} from '@/lib/services/streamer-ranking'

/** DB 関数が返す jsonb 相当（postgres.js は jsonb を JS オブジェクトへパースする）。 */
interface DbPayload {
  schemaVersion: number
  computedAt: string | null
  rankings: Array<Record<string, unknown>>
}

function dbPayload(): DbPayload {
  return {
    schemaVersion: 1,
    computedAt: '2026-10-07T11:00:00.000Z',
    rankings: [
      {
        metric: 'draws',
        period: 'total',
        participantCount: 13,
        insufficientData: false,
        self: { value: 50, rank: 1, percentile: 100 },
        top: [{ rank: 1, value: 50, isSelf: true }],
        neighbors: [],
      },
      {
        metric: 'draws',
        period: 'weekly',
        participantCount: 13,
        insufficientData: false,
        self: null,
        top: [],
        neighbors: [{ rank: 11, value: 5, isSelf: false }],
      },
      {
        metric: 'draws',
        period: 'daily',
        participantCount: 2,
        insufficientData: true,
        self: { value: 10, rank: null, percentile: null },
        top: [],
        neighbors: [],
      },
      {
        metric: 'card_count',
        period: 'current',
        participantCount: 5,
        insufficientData: true,
        self: { value: 4, rank: null, percentile: null },
        top: [],
        neighbors: [],
      },
    ],
  }
}

describe('getStreamerRanking (Issue #742)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getDb.mockResolvedValue({ sql: mocks.sql })
  })

  it('DB 関数を streamerId 付きで1文だけ呼び、contract どおりに返す', async () => {
    mocks.sql.mockResolvedValueOnce([{ payload: dbPayload() }])

    const outcome = await getStreamerRanking('11111111-1111-4111-8111-111111111111')

    expect(outcome).toEqual({
      available: true,
      response: {
        schemaVersion: STREAMER_RANKING_SCHEMA_VERSION,
        computedAt: '2026-10-07T11:00:00.000Z',
        rankings: dbPayload().rankings,
      },
    })

    expect(mocks.sql).toHaveBeenCalledTimes(1)
    const [strings, ...values] = mocks.sql.mock.calls[0] as [TemplateStringsArray, ...unknown[]]
    expect(strings.join('?')).toContain('get_streamer_ranking')
    expect(strings.join('?')).toContain('::uuid')
    expect(values).toEqual(['11111111-1111-4111-8111-111111111111'])
  })

  it('postgres.js が数値を文字列で返しても数値へ正規化する', async () => {
    const payload = dbPayload()
    payload.rankings = [
      {
        metric: 'draws',
        period: 'total',
        participantCount: '13',
        insufficientData: true,
        self: { value: '50', rank: '1', percentile: '100' },
        top: [{ rank: '1', value: '50', isSelf: 'yes' }],
        neighbors: [],
      },
    ]
    mocks.sql.mockResolvedValueOnce([{ payload }])

    const outcome = await getStreamerRanking('11111111-1111-4111-8111-111111111111')

    expect(outcome).toEqual({
      available: true,
      response: {
        schemaVersion: 1,
        computedAt: '2026-10-07T11:00:00.000Z',
        rankings: [
          {
            metric: 'draws',
            period: 'total',
            participantCount: 13,
            insufficientData: true,
            self: { value: 50, rank: 1, percentile: 100 },
            // isSelf は true 以外を false に寄せる（JSON の truthy 文字列に引きずられない）
            top: [{ rank: 1, value: 50, isSelf: false }],
            neighbors: [],
          },
        ],
      },
    })
  })

  it('snapshot 0 行（computedAt null・全エントリ insufficientData）も contract として通す', async () => {
    const payload = dbPayload()
    payload.computedAt = null
    payload.rankings = payload.rankings.map((entry) => ({
      ...entry,
      participantCount: 0,
      insufficientData: true,
      top: [],
      neighbors: [],
    }))
    mocks.sql.mockResolvedValueOnce([{ payload }])

    const outcome = await getStreamerRanking('11111111-1111-4111-8111-111111111111')

    expect(outcome.available).toBe(true)
    if (!outcome.available) throw new Error('unreachable')
    expect(outcome.response.computedAt).toBeNull()
    expect(outcome.response.rankings).toHaveLength(4)
    expect(outcome.response.rankings.every((entry) => entry.insufficientData)).toBe(true)
  })

  it('undefined_function (42883) をデプロイ窓の unavailable へ写像する', async () => {
    mocks.sql.mockRejectedValueOnce(
      Object.assign(new Error('function does not exist'), { code: '42883' })
    )

    await expect(getStreamerRanking('11111111-1111-4111-8111-111111111111')).resolves.toEqual({
      available: false,
      code: '42883',
    })
  })

  it('undefined_table (42P01) をデプロイ窓の unavailable へ写像する', async () => {
    mocks.sql.mockRejectedValueOnce(
      Object.assign(new Error('relation does not exist'), { code: '42P01' })
    )

    await expect(getStreamerRanking('11111111-1111-4111-8111-111111111111')).resolves.toEqual({
      available: false,
      code: '42P01',
    })
  })

  it('想定外のエラーは rethrow する（縮退させない）', async () => {
    mocks.sql.mockRejectedValueOnce(Object.assign(new Error('connection reset'), { code: '08006' }))

    await expect(getStreamerRanking('11111111-1111-4111-8111-111111111111')).rejects.toThrow(
      'connection reset'
    )
  })

  it.each([
    ['レスポンスが null', null],
    ['schemaVersion が違う', { ...dbPayload(), schemaVersion: 2 }],
    ['未知の metric', { ...dbPayload(), rankings: [{ metric: 'other', period: 'total' }] }],
    ['top が配列でない', { ...dbPayload(), rankings: [{ metric: 'draws', period: 'total', top: {} }] }],
    ['self.value 欠落', { ...dbPayload(), rankings: [{ metric: 'draws', period: 'total', self: { rank: 1 } }] }],
  ])('contract 違反（%s）は黙って流さず例外にする', async (_label, payload) => {
    mocks.sql.mockResolvedValueOnce([{ payload }])

    await expect(
      getStreamerRanking('11111111-1111-4111-8111-111111111111')
    ).rejects.toThrow(/streamer-ranking/)
  })
})

describe('normalizeStreamerRankingPayload (Issue #742)', () => {
  it('self/top/neighbors を深くコピーし、DB 応答をそのまま参照しない', () => {
    const payload = dbPayload()
    const normalized = normalizeStreamerRankingPayload(payload)

    expect(normalized.rankings[0]).not.toBe(payload.rankings[0])
    expect(normalized.rankings[0].top).not.toBe(payload.rankings[0].top)
    expect(normalized).toEqual({
      schemaVersion: 1,
      computedAt: '2026-10-07T11:00:00.000Z',
      rankings: payload.rankings,
    })
  })
})
