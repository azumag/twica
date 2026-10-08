import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import StreamerRanking from '@/components/StreamerRanking'
import type {
  StreamerRankingEntry,
  StreamerRankingResponse,
  StreamerRankingRow,
} from '@/lib/streamer-ranking-contract'
import jaMessages from '../../../messages/ja.json'

/**
 * 統計ページ「他チャンネル比較」タブ (#642 子C / #743) のコンポーネントテスト。
 *
 * 匿名性そのものは子B (#742) の DB/contract テストが担保する。ここでは
 * 「UI が contract の情報だけで描画され、上位50%ルールや各状態を設計どおり
 * 表示する」ことを検証する。payload に contract 外のフィールド
 * (SENTINEL_*) を混ぜ、UI がそれらを拾って描画しないことも固定する。
 */

const ja = jaMessages.gachaStatsPage.comparison

function rows(values: number[], selfIndexes: number[] = []): StreamerRankingRow[] {
  return values.map((value, index) => ({
    rank: index + 1,
    value,
    isSelf: selfIndexes.includes(index),
  }))
}

function entry(
  metric: StreamerRankingEntry['metric'],
  period: StreamerRankingEntry['period'],
  overrides: Partial<StreamerRankingEntry> = {},
): StreamerRankingEntry {
  return {
    metric,
    period,
    participantCount: 87,
    insufficientData: false,
    self: { value: 2050, rank: 12, percentile: 86 },
    top: rows([12000, 9000, 7000, 6000, 5000, 4000, 3500, 3000, 2500, 2200]),
    neighbors: [{ rank: 13, value: 1980, isSelf: false }],
    ...overrides,
  }
}

function response(overrides: Partial<StreamerRankingResponse> = {}): StreamerRankingResponse {
  return {
    schemaVersion: 1,
    computedAt: new Date().toISOString(),
    rankings: [
      entry('draws', 'total', {
        self: { value: 2050, rank: 12, percentile: 87 },
        top: [
          ...rows([12000, 9000, 7000, 6000, 5000, 4000, 3500, 3000, 2500, 2200]),
        ],
        neighbors: [{ rank: 12, value: 2050, isSelf: true }],
      }),
      entry('draws', 'daily', {
        participantCount: 34,
        self: { value: 40, rank: 5, percentile: 88 },
        top: rows([90, 80, 70, 60, 40, 30, 20, 10, 5, 4]),
        neighbors: [],
      }),
      entry('draws', 'weekly', {
        participantCount: 61,
        self: { value: 300, rank: 8, percentile: 89 },
        top: rows([900, 800, 700, 600, 500, 400, 350, 300, 250, 200]),
        neighbors: [],
      }),
      entry('card_count', 'current', {
        self: { value: 20, rank: 20, percentile: 78 },
        top: rows([60, 55, 50, 45, 40, 35, 30, 28, 25, 22]),
        neighbors: [],
      }),
    ],
    ...overrides,
  }
}

function mockFetch(payload: StreamerRankingResponse | null, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(status >= 400 ? JSON.stringify({ error: 'x' }) : JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

function renderComponent() {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <StreamerRanking />
    </NextIntlClientProvider>,
  )
}

function bodyRanks() {
  return Array.from(
    document.querySelectorAll('table tbody tr td:first-child'),
  ).map((cell) => cell.textContent)
}

describe('StreamerRanking (#642 子C)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('自分の順位サマリーと匿名ランキングを描画し、他チャンネル識別子を拾わない', async () => {
    // contract 外の識別子を混ぜ、UI がそれらを描画しないことを固定する。
    const payload = response()
    ;(payload as unknown as Record<string, unknown>).SENTINEL_NAME = 'SENTINEL_OTHER_CHANNEL'
    ;(payload.rankings[0] as unknown as Record<string, unknown>).streamerId = 'SENTINEL_UUID'
    mockFetch(payload)

    renderComponent()

    // サマリー: 累計は 12位/87 + 上位13.8%（rank / 母集団 = 12/87）
    expect(await screen.findByText(ja.summaryHeading)).toBeTruthy()
    expect(screen.getByText('12位/87')).toBeTruthy()
    expect(screen.getByText('上位13.8%')).toBeTruthy()
    // 今日: 5位/34 → 上位14.7%
    expect(screen.getByText('5位/34')).toBeTruthy()
    // カード登録数: 20位/87
    expect(screen.getByText('20位/87')).toBeTruthy()

    // ランキングボード: top 10 + 省略行 + neighbors 1
    expect(bodyRanks().length).toBe(10 + 1 + 1)
    // 自分の行は「あなた」バッジ付きでハイライトされる
    expect(screen.getByText(ja.you)).toBeTruthy()
    expect(screen.getByText(ja.you).closest('tr')?.className).toContain('bg-purple-600/20')
    // 順位は同値・飛び番をそのまま表示する（summary の rank をボードでも透過）
    expect(bodyRanks()[0]).toBe('1')

    // 匿名性: contract 外の識別子は DOM に現れない
    expect(document.body.textContent).not.toContain('SENTINEL')
  })

  it('下位半分では「上位◯%」を表示しない（順位は隠さない）', async () => {
    // percentile は DB では下位でも非 NULL（1位=100 の百分位）で返るため、
    // 上位50%以内かどうかは UI 側で判定する必要がある。
    const payload = response({
      rankings: [
        entry('draws', 'total', {
          participantCount: 34,
          self: { value: 10, rank: 30, percentile: 15 },
        }),
        entry('draws', 'daily', {
          participantCount: 34,
          self: { value: 1, rank: 33, percentile: 6 },
        }),
        entry('draws', 'weekly', {
          participantCount: 61,
          self: { value: 2, rank: 60, percentile: 3 },
        }),
        entry('card_count', 'current', {
          self: { value: 5, rank: 80, percentile: 9 },
        }),
      ],
    })
    mockFetch(payload)

    renderComponent()

    // 順位そのものは表示する
    expect(await screen.findByText('30位/34')).toBeTruthy()
    expect(screen.getByText('33位/34')).toBeTruthy()
    // 上位◯% はどのカードにも出ない（「上位100.0%」のような事故を防ぐ）
    expect(screen.queryByText(/上位/)).toBeNull()
  })

  it('participant が5未満（insufficientData）では順位表ではなく注記を出す', async () => {
    const payload = response({
      rankings: [
        entry('draws', 'total', {
          participantCount: 4,
          insufficientData: true,
          self: { value: 30, rank: null, percentile: null },
          top: [],
          neighbors: [],
        }),
      ],
    })
    mockFetch(payload)

    renderComponent()

    expect(await screen.findByText(ja.insufficientData)).toBeTruthy()
    // 順位が無いので数値のみ（自分の値）を表示
    expect(screen.getByText('30')).toBeTruthy()
    expect(screen.getByText(ja.rankUnavailable)).toBeTruthy()
    expect(document.querySelector('table')).toBeNull()
  })

  it('メトリクス切替で選択中のランキングを差し替える', async () => {
    mockFetch(response())

    renderComponent()

    // 既定は累計。カード登録数に切り替えると値列見出しと順位が変わる
    const button = await screen.findByRole('button', { name: ja.metrics.cardCount })
    fireEvent.click(button)

    await waitFor(() => {
      expect(screen.getAllByText(ja.valueCardCount).length).toBeGreaterThan(0)
    })
    // カード登録数の1位の値がボードに描画される（既定の累計ボードではない）
    expect(screen.getByText('60')).toBeTruthy()
  })

  it('期間内0回（self: null）は「—」と案内を表示する', async () => {
    const payload = response({
      rankings: [
        entry('draws', 'total', { self: null, top: [], neighbors: [] }),
      ],
    })
    mockFetch(payload)

    renderComponent()

    expect((await screen.findAllByText(ja.noDataInPeriod)).length).toBeGreaterThan(0)
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  it('母集団外（rank: null / value > 0）は実数値と対象外案内を表示する', async () => {
    const payload = response({
      rankings: [
        entry('draws', 'total', {
          self: { value: 300, rank: null, percentile: null },
          top: rows([100, 90, 80, 70, 60]),
          neighbors: [],
        }),
      ],
    })
    mockFetch(payload)

    renderComponent()

    expect(await screen.findByText(ja.outOfPopulation)).toBeTruthy()
    expect(screen.getByText('300')).toBeTruthy()
  })

  it('backfill 前（computedAt: null）は「集計準備中」のみ表示する', async () => {
    mockFetch(response({ computedAt: null }))

    renderComponent()

    expect(await screen.findByText(ja.preparing)).toBeTruthy()
    expect(document.querySelector('table')).toBeNull()
  })

  it('取得失敗時はエラーと再試行を表示し、再試行で回復する', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'x' }), { status: 500 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(response()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

    renderComponent()

    expect(await screen.findByText(ja.loadError)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: ja.retry }))

    await waitFor(() => {
      expect(screen.getByText(ja.summaryHeading)).toBeTruthy()
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
