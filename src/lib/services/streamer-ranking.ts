/**
 * Issue #742 (子B): 匿名ランキングの読み取り層。
 *
 * 匿名化は DB 関数 public.get_streamer_ranking(uuid) の応答生成時点で完結する
 * (migration 20261007190000_streamer_ranking_read_function.sql)。このモジュールは
 * その関数を1文で呼び、postgres.js が返す jsonb を contract 型へ正規化するだけの
 * 薄い層であり、他チャンネルの識別子を扱うコードを一切持たない（そもそも受け取らない）。
 * PostgREST / dual-driver 分岐は持たない（現行 PlanetScale 単一 runtime）。
 *
 * 読み取り量: snapshot への数行 lookup（PK lookup + position index range）と、
 * 自分が母集団外のときだけ自分の行の集計（streamer_daily_stats の PK index scan /
 * cards の streamer_id index scan）であり、gacha_history は走査しない。
 *
 * キャッシュ層を持たない理由: 上記のとおりコールドヒットでも軽量である一方、
 * 現デプロイ構成（open-next.config.ts に incrementalCache/tagCache 未設定）では
 * `unstable_cache` の効果（共有キャッシュへの保存）を保証できないため、
 * 誤った期待を持つキャッシュを挟まない（Issue #742 の「着手時に再確認」への回答）。
 */
import { getDb } from '@/lib/db/client'
import { isPgFunctionNotFoundError, isPgMissingTableError } from '@/lib/db/errors'
import { withDbRetry } from '@/lib/db/retry'
import {
  STREAMER_RANKING_SCHEMA_VERSION,
  type RankingMetric,
  type RankingPeriod,
  type StreamerRankingResponse,
  type StreamerRankingRow,
} from '@/lib/streamer-ranking-contract'

// contract 型は子C（src/components/StreamerRanking.tsx）と共有するため
// src/lib/streamer-ranking-contract.ts へ分離した。既存の import 元
// （このモジュール）からも従来どおり参照できるよう re-export する。
export {
  STREAMER_RANKING_SCHEMA_VERSION,
  type RankingMetric,
  type RankingPeriod,
  type StreamerRankingRow,
  type StreamerRankingSelf,
  type StreamerRankingEntry,
  type StreamerRankingResponse,
} from '@/lib/streamer-ranking-contract'


export type StreamerRankingOutcome =
  | { available: true; response: StreamerRankingResponse }
  | {
      /** 集計 migration 未適用のデプロイ窓 (42883 / 42P01)。呼び出し側は 503 へ。 */
      available: false
      code: '42883' | '42P01'
    }

const RANKING_METRICS: readonly RankingMetric[] = ['draws', 'card_count']
const RANKING_PERIODS: readonly RankingPeriod[] = ['daily', 'weekly', 'total', 'current']

function toFiniteNumber(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`[streamer-ranking] ${field} is not a number: ${String(value)}`)
  }
  return parsed
}

function toNullableNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null
  return toFiniteNumber(value, field)
}

function toRankedRows(value: unknown, field: string): StreamerRankingRow[] {
  if (!Array.isArray(value)) {
    throw new Error('[streamer-ranking] ' + field + ' is not an array')
  }
  return value.map((row) => {
    const record = (row ?? {}) as Record<string, unknown>
    return {
      rank: toFiniteNumber(record.rank, `${field}[].rank`),
      value: toFiniteNumber(record.value, `${field}[].value`),
      isSelf: record.isSelf === true,
    }
  })
}

/**
 * DB 関数の応答を contract 型へ正規化する。
 *
 * DB が producer なので通常はそのまま通るが、migration とアプリのデプロイが食い違った
 * 場合に壊れた contract をクライアントへ流さないよう、形が違えば例外にする
 * （handleApiError 経由で 5xx + 構造化ログに載り、UI 側は「取得失敗」として扱える）。
 */
export function normalizeStreamerRankingPayload(raw: unknown): StreamerRankingResponse {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('[streamer-ranking] DB payload is not an object')
  }
  const payload = raw as Record<string, unknown>

  const schemaVersion = toFiniteNumber(payload.schemaVersion, 'schemaVersion')
  if (schemaVersion !== STREAMER_RANKING_SCHEMA_VERSION) {
    throw new Error(
      `[streamer-ranking] unexpected schemaVersion: ${schemaVersion}`
    )
  }
  if (payload.computedAt !== null && payload.computedAt !== undefined && typeof payload.computedAt !== 'string') {
    throw new Error('[streamer-ranking] computedAt is neither a string nor null')
  }
  if (!Array.isArray(payload.rankings)) {
    throw new Error('[streamer-ranking] rankings is not an array')
  }

  const rankings = payload.rankings.map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>
    const metric = record.metric
    const period = record.period
    if (typeof metric !== 'string' || !RANKING_METRICS.includes(metric as RankingMetric)) {
      throw new Error(`[streamer-ranking] unknown metric: ${String(metric)}`)
    }
    if (typeof period !== 'string' || !RANKING_PERIODS.includes(period as RankingPeriod)) {
      throw new Error(`[streamer-ranking] unknown period: ${String(period)}`)
    }

    const selfValue = record.self
    const self =
      selfValue === null || selfValue === undefined
        ? null
        : (() => {
            const selfRecord = selfValue as Record<string, unknown>
            return {
              value: toFiniteNumber(selfRecord.value, 'self.value'),
              rank: toNullableNumber(selfRecord.rank, 'self.rank'),
              percentile: toNullableNumber(selfRecord.percentile, 'self.percentile'),
            }
          })()

    return {
      metric: metric as RankingMetric,
      period: period as RankingPeriod,
      participantCount: toFiniteNumber(record.participantCount, 'participantCount'),
      insufficientData: record.insufficientData === true,
      self,
      top: toRankedRows(record.top, 'top'),
      neighbors: toRankedRows(record.neighbors, 'neighbors'),
    }
  })

  return {
    schemaVersion: STREAMER_RANKING_SCHEMA_VERSION,
    computedAt: (payload.computedAt as string | null | undefined) ?? null,
    rankings,
  }
}

/**
 * 匿名ランキング（4 メトリクス分）を取得する。
 *
 * 読み取り専用かつ単一文なので withDbRetry の idempotent リトライで安全に再実行できる。
 * DB 関数が存在しない / テーブルが無いデプロイ窓は例外にせず unavailable を返し、
 * 呼び出し側に 503 の判断を委ねる（PACK_RENAME_NOT_READY / STATS_REFRESH_NOT_READY と同型）。
 */
export async function getStreamerRanking(streamerId: string): Promise<StreamerRankingOutcome> {
  try {
    const raw = await withDbRetry(
      async () => {
        const { sql } = await getDb()
        const rows = await sql<{ payload: unknown }[]>`
          select public.get_streamer_ranking(${streamerId}::uuid) as payload
        `
        return rows[0]?.payload ?? null
      },
      'streamer-ranking',
      { idempotent: true },
    )
    return { available: true as const, response: normalizeStreamerRankingPayload(raw) }
  } catch (error) {
    if (isPgFunctionNotFoundError(error)) {
      return { available: false, code: '42883' }
    }
    if (isPgMissingTableError(error)) {
      return { available: false, code: '42P01' }
    }
    throw error
  }
}
