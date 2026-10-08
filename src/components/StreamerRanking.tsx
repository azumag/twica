'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  type RankingMetric,
  type RankingPeriod,
  type StreamerRankingEntry,
  type StreamerRankingResponse,
  type StreamerRankingRow,
} from '@/lib/streamer-ranking-contract'

/**
 * 統計ページ「他チャンネル比較」タブ (Issue #642 子C / #743)。
 *
 * - データ源は GET /api/streamer-ranking（子B #742 の匿名化済み contract）。
 *   レスポンスに他チャンネルの識別子は存在せず、このコンポーネントは
 *   contract に無い情報を描画できない（`streamer-ranking-contract.ts` 参照）。
 * - チャートライブラリは導入せず Tailwind の div 幅でバーを描く（既存統計UIと同一方針）。
 * - 順位は「表示 rank」（同値同順位）。近傍行は子Bが top と重複しないよう position で
 *   選別済みなので、ここでは top → 省略行 → neighbors の順にそのまま並べるだけでよい。
 */

/** 表示順は UI 側で固定する（API の rankings 順に依存しない）。 */
const METRIC_VIEWS: ReadonlyArray<{ metric: RankingMetric; period: RankingPeriod }> = [
  { metric: 'draws', period: 'total' },
  { metric: 'draws', period: 'daily' },
  { metric: 'draws', period: 'weekly' },
  { metric: 'card_count', period: 'current' },
]

type MetricView = (typeof METRIC_VIEWS)[number]

/** メトリクス/期間から表示ラベルキーを返す（静的な文字列のみを返す）。 */
function metricLabelKey(view: MetricView): string {
  if (view.metric === 'card_count') return 'comparison.metrics.cardCount'
  if (view.period === 'daily') return 'comparison.metrics.drawsDaily'
  if (view.period === 'weekly') return 'comparison.metrics.drawsWeekly'
  return 'comparison.metrics.drawsTotal'
}

/** 数値列の見出し（メトリクスで意味が変わる）。 */
function valueLabelKey(view: MetricView): string {
  return view.metric === 'card_count'
    ? 'comparison.valueCardCount'
    : 'comparison.valueDraws'
}

/**
 * ユーザー向けの「上位◯%」= 母集団中で自分以上の順位の割合 (rank / participantCount)。
 *
 * 子B contract の `percentile` は「自分より上位でない参加者の割合」
 * (round(100 * (n - rank + 1) / n)、1位=100) で、ユーザー向けの「上位◯%」とは
 * 補数の関係にある（例: 87 チャンネル中 12 位 → percentile 87 / 上位 13.8%）。
 * #743 のデザインモックは後者（rank / 母集団）を表示しているため、表示値は
 * rank から導出する。contract の percentile は「順位が存在する（= 匿名化の
 * 最小母集団を満たす）」ことの表明として取得判定に使う。
 *
 * 下位配信者への配慮として「上位◯%」は上位50%以内（表示値 <= 50%）のときのみ出す。
 * DB は下位でも percentile を非NULLで返す（contract 側では null 化しない）ため、
 * この判定は UI 側で行う必要がある。
 */
function topPercent(rank: number, participantCount: number): number {
  if (participantCount <= 0) return 100
  return Math.round((rank / participantCount) * 1000) / 10
}

function findEntry(
  rankings: StreamerRankingEntry[],
  view: MetricView,
): StreamerRankingEntry | null {
  return (
    rankings.find(
      (entry) => entry.metric === view.metric && entry.period === view.period,
    ) ?? null
  )
}

/**
 * computedAt からの経過。stale（3時間超）は鮮度注記を強調表示するだけで
 * エラー扱いにはしない（バッチが数サイクル停滞しても前回スナップショットは有効）。
 */
function relativeAge(computedAt: string, now: number) {
  const parsed = Date.parse(computedAt)
  const minutes = Number.isFinite(parsed)
    ? Math.max(0, Math.floor((now - parsed) / 60000))
    : 0
  return { minutes, hours: Math.floor(minutes / 60), stale: minutes >= 180 }
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: StreamerRankingResponse }

export default function StreamerRanking() {
  const t = useTranslations('gachaStatsPage')
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [selected, setSelected] = useState(0)
  const [now, setNow] = useState(() => Date.now())

  const retry = useCallback(() => setAttempt((value) => value + 1), [])

  useEffect(() => {
    // computedAt の経過と stale 色を表示中にも正しく反映するため、時計だけを分単位で更新する。
    // API データの再取得とは独立させ、アンマウント時には interval を必ず解放する。
    const interval = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    setState({ status: 'loading' })

    const load = async () => {
      try {
        const res = await fetch('/api/streamer-ranking', {
          signal: controller.signal,
        })
        if (!res.ok) {
          throw new Error(`streamer-ranking: unexpected status ${res.status}`)
        }
        const data = (await res.json()) as StreamerRankingResponse
        if (!cancelled) {
          setNow(Date.now())
          setState({ status: 'ready', data })
        }
      } catch (error) {
        // abort はタブ切替/アンマウントによる正常系なのでエラー表示しない。
        if (cancelled || (error as Error)?.name === 'AbortError') return
        setState({ status: 'error' })
      }
    }

    void load()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [attempt])

  // 匿名注記は状態によらず常時表示する（プライバシー不安を先回りで解消する）。
  const anonymityNotice = (
    <p className="mb-4 text-xs text-gray-500">{t('comparison.anonymityNotice')}</p>
  )

  if (state.status === 'loading') {
    return (
      <div>
        {anonymityNotice}
        <div className="py-12 text-center text-gray-400">
          <div className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-gray-500 border-t-purple-500" />
        </div>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div>
        {anonymityNotice}
        <div className="py-12 text-center text-gray-400">
          <p className="mb-4">{t('comparison.loadError')}</p>
          <button
            type="button"
            onClick={retry}
            className="rounded-lg border border-gray-600 px-4 py-2 text-sm font-medium text-gray-200 hover:bg-gray-700"
          >
            {t('comparison.retry')}
          </button>
        </div>
      </div>
    )
  }

  const { data } = state

  // backfill 完了前は snapshot が一切生成されない（computedAt: null）。
  // 誤った累計・週間ランキングを見せないため、この状態では数値を出さない。
  if (data.computedAt === null) {
    return (
      <div>
        {anonymityNotice}
        <div className="py-12 text-center text-gray-400">
          {t('comparison.preparing')}
        </div>
      </div>
    )
  }

  const age = relativeAge(data.computedAt, now)
  const updatedAt =
    age.minutes < 60
      ? t('comparison.minutesAgo', { minutes: age.minutes })
      : t('comparison.hoursAgo', { hours: age.hours })

  const activeView = METRIC_VIEWS[selected]
  const activeEntry = findEntry(data.rankings, activeView)

  const renderRow = (row: StreamerRankingRow, index: number, maxValue: number) => (
    <tr
      key={`${row.rank}-${row.value}-${index}`}
      className={row.isSelf ? 'bg-purple-600/20' : undefined}
    >
      <td className="w-16 p-3 text-right font-medium text-gray-300">{row.rank}</td>
      <td className="p-3">
        {/* バーは装飾。数値テキストを正とする（aria-hidden） */}
        <div className="h-3 w-full rounded bg-gray-700" aria-hidden="true">
          <div
            className="h-3 rounded bg-purple-500"
            style={{ width: `${maxValue > 0 ? (row.value / maxValue) * 100 : 0}%` }}
          />
        </div>
      </td>
      <td className="p-3 text-right font-medium text-white">
        {row.value.toLocaleString()}
        {row.isSelf && (
          <span className="ml-2 rounded bg-purple-600 px-2 py-0.5 text-xs text-white">
            {t('comparison.you')}
          </span>
        )}
      </td>
    </tr>
  )

  const boardRows = activeEntry ? [...activeEntry.top, ...activeEntry.neighbors] : []
  const maxValue = boardRows.reduce((max, row) => Math.max(max, row.value), 0)
  const boardLabel = t('comparison.boardLabel', {
    metric: t(metricLabelKey(activeView)),
  })

  return (
    <div>
      {anonymityNotice}
      <p className={`mb-6 text-xs ${age.stale ? 'text-amber-400' : 'text-gray-500'}`}>
        {t('comparison.updatedAt', { time: updatedAt })}
      </p>

      <h3 className="mb-2 text-sm font-semibold text-gray-300">
        {t('comparison.summaryHeading')}
      </h3>
      <div className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-4">
        {METRIC_VIEWS.map((view) => {
          const entry = findEntry(data.rankings, view)
          const self = entry?.self ?? null
          let sub = ''
          if (!entry || self === null) {
            sub = t('comparison.noDataInPeriod')
          } else if (self.rank === null) {
            sub = entry.insufficientData
              ? t('comparison.rankUnavailable')
              : t('comparison.outOfPopulation')
          } else if (self.percentile !== null) {
            const pct = topPercent(self.rank, entry.participantCount)
            // 下位半分では「上位◯%」を出さない（順位そのものは隠さない）。
            if (pct <= 50) {
              sub = t('comparison.percentileTop', { pct })
            }
          }

          return (
            <div key={metricLabelKey(view)} className="rounded-xl bg-gray-800 p-4">
              <div className="text-xs text-gray-400">{t(metricLabelKey(view))}</div>
              <div className="mt-1 text-xl font-semibold text-white">
                {self === null ? (
                  <span className="text-gray-500">—</span>
                ) : self.rank !== null && entry ? (
                  t('comparison.rankOf', {
                    rank: self.rank,
                    count: entry.participantCount,
                  })
                ) : (
                  self.value.toLocaleString()
                )}
              </div>
              {sub && <div className="mt-1 text-xs text-gray-500">{sub}</div>}
            </div>
          )
        })}
      </div>

      <h3 className="mb-2 text-sm font-semibold text-gray-300">
        {t('comparison.boardHeading')}
      </h3>
      <div className="mb-4 flex flex-wrap gap-2">
        {METRIC_VIEWS.map((view, index) => (
          <button
            key={metricLabelKey(view)}
            type="button"
            onClick={() => setSelected(index)}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              selected === index
                ? 'bg-purple-600 text-white'
                : 'border border-gray-600 text-gray-300 hover:bg-gray-700'
            }`}
          >
            {t(metricLabelKey(view))}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl bg-gray-800">
        {!activeEntry ? (
          <div className="p-6 text-sm text-gray-400">{t('noData')}</div>
        ) : activeEntry.insufficientData ? (
          <div className="p-6 text-sm text-gray-400">
            {t('comparison.insufficientData')}
          </div>
        ) : (
          <table className="w-full text-sm" aria-label={boardLabel}>
            <thead>
              <tr className="border-b border-gray-700 text-left text-gray-400">
                <th scope="col" className="w-16 p-3 text-right">
                  {t('comparison.rank')}
                </th>
                {/* バー列。装飾なので見出しラベルを持たない */}
                <th scope="col" className="p-3" aria-hidden="true" />
                <th scope="col" className="w-32 p-3 text-right">
                  {t(valueLabelKey(activeView))}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-700">
              {activeEntry.top.map((row, index) => renderRow(row, index, maxValue))}
              {activeEntry.neighbors.length > 0 && (
                <>
                  <tr>
                    <td colSpan={3} className="p-2 text-center text-gray-500">
                      ···
                    </td>
                  </tr>
                  {activeEntry.neighbors.map((row, index) =>
                    renderRow(row, activeEntry.top.length + index, maxValue),
                  )}
                </>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
