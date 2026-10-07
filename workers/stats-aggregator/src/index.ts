/**
 * Stats Aggregator Cron Worker (Issue #741)
 *
 * ランキング用統計バッチの定期実行Worker。毎時1回、本体アプリの内部API
 * POST /api/internal/stats/refresh をHTTP経由で叩く「トリガー」に徹する。
 *
 * このファイルは定期呼び出しのコードのみを追加する。実際のCloudflare
 * Cronデプロイ・secret設定・.github/workflows/deploy-cloudflare.ymlへの
 * 登録は、このPRの範囲外 (workers/chat-delivery と同じ導入順序)。
 *
 * 設計上の制約 (Issue #741 本文より、現行アーキテクチャへ再ベースライン済み):
 * - DB接続・Supabase依存を持たない (#711 の教訓)。集計ロジックは本体アプリ側の
 *   refresh_streamer_ranking() に集約し、このWorker側では複製しない。
 * - 失敗時はconsole.errorに残すのみ。スナップショットは前回値が残るため、
 *   数時間の停滞は「computed_atが古い」だけで壊れず、次回tickで回復する。
 */

export const STATS_REFRESH_CRON = '5 * * * *'

const STATS_REFRESH_PATH = '/api/internal/stats/refresh'

/**
 * 内部refreshエンドポイント呼び出しのタイムアウト (ミリ秒)。
 * 集計は全体再計算のため数十秒かかりうるが、cron tickの実行寿命内に
 * 収まるよう上限を設ける。タイムアウト時は次回tickに委ねる。
 */
const STATS_REFRESH_CALL_TIMEOUT_MS = 120_000

/** 内部refreshエンドポイントのレスポンス形状 (route.ts の戻り値と一致させる)。 */
export interface StatsRefreshResponseBody {
  skipped: boolean
  reason: string
  snapshotCount: number
  computedAt: string | null
  durationMs: number
}

export interface StatsRefreshTarget {
  /** ログに出す環境名。 */
  name: string
  baseUrl: string | undefined
  refreshSecret: string | undefined
}

export interface Env {
  /**
   * 本番アプリ (`twica`) のベースURL。例: https://twica.bluemoon.works
   * previewアプリ (`twica-preview`) とは別々のCloudflare Workersデプロイ・
   * 別ドメインのため、prod/preview両方を明示的に対象にする
   * (error-reporterのAPP_BASE_URL_PROD/PREVIEWと同じ立て付け)。
   */
  APP_BASE_URL_PROD?: string
  /** previewアプリ (`twica-preview`) のベースURL。 */
  APP_BASE_URL_PREVIEW?: string
  /**
   * 本番アプリの `STATS_REFRESH_SECRET`
   * (`src/app/api/internal/stats/refresh/route.ts` が検証する共有シークレット)
   * と同じ値を `wrangler secret put STATS_REFRESH_SECRET_PROD` で設定する想定。
   * prod/previewで別々のsecret値を運用する前提のため_PROD/_PREVIEWを分ける。
   * 未設定の場合は該当ターゲットへの呼び出しのみを安全にスキップする。
   */
  STATS_REFRESH_SECRET_PROD?: string
  /** previewアプリの `STATS_REFRESH_SECRET` と同じ値。上記コメント参照。 */
  STATS_REFRESH_SECRET_PREVIEW?: string
}

/** 末尾のスラッシュを取り除く (設定ミスで付いていても安全に動くようにする)。 */
export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * 1ターゲットに対する集計バッチ呼び出し。
 * baseUrl/secretのいずれかが未設定ならwarnしてno-op (fail-closedではなく
 * 「設定前は動かさない」。エラーも投げない)。
 * HTTP失敗・非2xx・形状不正はいずれもconsole.errorに残し、例外を投げない
 * (呼び出し元の独立性を明示的に保証するため。この関数内で完結させることで
 * 「prod失敗時にpreviewの処理が止まらない」ことを構造的に保証する)。
 */
export async function callStatsRefreshForTarget(
  target: StatsRefreshTarget,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const { name, refreshSecret } = target
  const baseUrl = target.baseUrl ? stripTrailingSlash(target.baseUrl) : undefined

  if (!baseUrl) {
    console.warn(`[Stats Aggregator] Missing base URL for ${name}, skipping`)
    return
  }
  if (!refreshSecret) {
    console.warn(`[Stats Aggregator] Missing refresh secret for ${name}, skipping (set it via wrangler secret put)`)
    return
  }

  try {
    const res = await fetchImpl(`${baseUrl}${STATS_REFRESH_PATH}`, {
      method: 'POST',
      headers: { 'x-stats-refresh-secret': refreshSecret },
      signal: AbortSignal.timeout(STATS_REFRESH_CALL_TIMEOUT_MS),
    })
    if (!res.ok) {
      const text = await res.text()
      console.error(`[Stats Aggregator] stats refresh returned ${res.status} for ${name}: ${text}`)
      return
    }
    const body = (await res.json()) as StatsRefreshResponseBody
    if (typeof body.skipped !== 'boolean') {
      console.error(`[Stats Aggregator] unexpected refresh response shape for ${name}`)
      return
    }
    console.log(
      `[Stats Aggregator] ${name}: skipped=${body.skipped} reason=${body.reason} ` +
      `snapshotCount=${body.snapshotCount} computedAt=${body.computedAt} durationMs=${body.durationMs}`
    )
  } catch (err) {
    console.error(`[Stats Aggregator] failed to call stats refresh for ${name}:`, err)
  }
}

/**
 * Cron Triggerハンドラ。prod/preview両ターゲットを独立に処理する
 * (片方の失敗が他方に波及しない。各ターゲット関数は例外を投げない設計だが、
 * 防御的にtry/catchも残す)。
 */
export async function runScheduledRefresh(env: Env, fetchImpl: typeof fetch = fetch): Promise<void> {
  console.log('[Stats Aggregator] Started')

  const targets: StatsRefreshTarget[] = [
    { name: 'production', baseUrl: env.APP_BASE_URL_PROD, refreshSecret: env.STATS_REFRESH_SECRET_PROD },
    { name: 'preview', baseUrl: env.APP_BASE_URL_PREVIEW, refreshSecret: env.STATS_REFRESH_SECRET_PREVIEW },
  ]

  for (const target of targets) {
    try {
      await callStatsRefreshForTarget(target, fetchImpl)
    } catch (err) {
      console.error(`[Stats Aggregator] ${target.name} failed:`, err)
    }
  }

  console.log('[Stats Aggregator] Completed')
}

export default {
  async scheduled(
    _event: ScheduledController,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    await runScheduledRefresh(env)
  },
}
