/**
 * Issue #741: ランキング用統計バッチの呼び出し層。
 *
 * 集計ロジック自体は PlanetScale 上の SQL 関数
 * (migration 20261007120000_streamer_stats_aggregation.sql) が担い、
 * このモジュールは内部 API からの呼び出し口だけを提供する。
 * PostgREST / dual-driver 分岐は持たない (現行 PlanetScale 単一 runtime)。
 *
 * 冪等性: refresh_streamer_ranking() 自体が冪等
 * (日次 upsert + snapshot のトランザクション置換 + advisory lock +
 * cooldown) のため withDbRetry({ idempotent: true }) で安全に再試行できる。
 */
import { getDb } from '@/lib/db/client'
import { isPgFunctionNotFoundError, isPgMissingTableError } from '@/lib/db/errors'
import { withDbRetry } from '@/lib/db/retry'

interface RefreshRankingRow {
  skipped: boolean
  reason: string
  snapshot_count: number | string
}

interface SnapshotFreshnessRow {
  computed_at: string | Date | null
}

export type StatsRefreshOutcome =
  | {
      available: true
      skipped: boolean
      /** 'refreshed' | 'cooldown' | 'lock-contention' | 'backfill-pending' */
      reason: string
      snapshotCount: number
      /** 最新 snapshot の computed_at (行が無ければ null)。ISO 8601 文字列。 */
      computedAt: string | null
    }
  | {
      /** migration 未適用のデプロイ窓 (42883 / 42P01)。呼び出し側は 503 へ。 */
      available: false
      code: '42883' | '42P01'
    }

function toIsoString(value: string | Date | null): string | null {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value.toISOString() : value
}

/**
 * refresh_streamer_ranking() を1回実行し、結果を正規化して返す。
 *
 * 関数の戻り値 (skipped / reason / snapshot_count) に加え、読み取り側の
 * 鮮度表示用に最新 snapshot の computed_at を付ける。snapshot 0 行の間
 * (backfill 前) は computedAt = null であり、呼び出し側は「集計準備中」
 * として扱う (#741 仕様。子 B / 子 C で定義済みの表示)。
 */
export async function runStatsRefresh(): Promise<StatsRefreshOutcome> {
  try {
    return await withDbRetry(
      async () => {
        const { sql } = await getDb()
        const rows = await sql<RefreshRankingRow[]>`
          select * from public.refresh_streamer_ranking()
        `
        const row = rows[0]
        if (!row) {
          throw new Error('[stats-refresh] refresh_streamer_ranking() returned no rows')
        }
        let computedAt: string | null = null
        if (!row.skipped) {
          const freshness = await sql<SnapshotFreshnessRow[]>`
            select max(computed_at) as computed_at
            from public.streamer_ranking_snapshots
          `
          computedAt = toIsoString(freshness[0]?.computed_at ?? null)
        }
        return {
          available: true as const,
          skipped: row.skipped,
          reason: row.reason,
          snapshotCount:
            typeof row.snapshot_count === 'string'
              ? Number.parseInt(row.snapshot_count, 10)
              : row.snapshot_count,
          computedAt,
        }
      },
      'stats:refresh',
      { idempotent: true },
    )
  } catch (error) {
    // デプロイ窓フォールバック: 集計 migration よりアプリが先に deploy
    // された場合は例外にせず unavailable として返す (PACK_RENAME_NOT_READY
    // / cardPackNamesSkippedDeployWindow と同じ判断)。
    if (isPgFunctionNotFoundError(error)) {
      return { available: false, code: '42883' }
    }
    if (isPgMissingTableError(error)) {
      return { available: false, code: '42P01' }
    }
    throw error
  }
}
