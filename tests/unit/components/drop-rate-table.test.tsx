import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import DropRateTable from '@/components/DropRateTable'

vi.mock('@/components/StreamerRanking', () => ({
  default: () => <div>streamer ranking</div>,
}))

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(' ')}` : key,
}))

const payload = (totalDraws: number, totalPoints: number) => ({
  totalDraws,
  channelPointStats: { totalPoints, ranking: [] },
  cardStats: [],
  rarityStats: [],
})

const jsonResponse = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }))

const clickTab = (tab: string) => fireEvent.click(screen.getByRole('button', { name: `tabs.${tab}` }))
const expectDrawCount = (count: number) =>
  waitFor(() => expect(document.querySelector('.text-3xl')?.textContent).toBe(String(count)))
const expectPoints = (points: number) =>
  waitFor(() => expect(document.body.textContent).toContain(`channelPointRanking.total ${points}`))

afterEach(() => vi.restoreAllMocks())

describe('DropRateTable period statistics', () => {
  it.each(['7d', 'channelPoints'] as const)('loads matching period data after 30d → comparison → %s', async (tab) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementation((input) => {
        const url = String(input)
        if (url.includes('period=30d')) return jsonResponse(payload(30, 300))
        if (url.includes('period=7d')) return jsonResponse(payload(7, 70))
        return jsonResponse({ cardStats: [] })
      })
    render(<DropRateTable />)
    await expectDrawCount(7)
    clickTab('30d')
    await expectDrawCount(30)
    clickTab('comparison')
    expect(await screen.findByText('streamer ranking')).toBeTruthy()
    clickTab(tab)
    if (tab === 'channelPoints') {
      await expectPoints(70)
    } else {
      await expectDrawCount(7)
    }
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/gacha-stats?period=7d',
      '/api/gacha-stats?period=30d',
      '/api/gacha-stats?period=7d',
    ])
  })

  it('reuses same-period data and does not fetch period stats for byCard or comparison', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.includes('period=byCard')) return jsonResponse({ cardStats: [] })
      return jsonResponse(payload(7, 70))
    })
    render(<DropRateTable />)
    await expectDrawCount(7)
    clickTab('channelPoints')
    await expectPoints(70)
    clickTab('7d')
    await expectDrawCount(7)
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/gacha-stats?period=7d',
    ])
    clickTab('byCard')
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    clickTab('comparison')
    await screen.findByText('streamer ranking')
    clickTab('7d')
    await expectDrawCount(7)
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/gacha-stats?period=7d',
      '/api/gacha-stats?period=byCard',
    ])
  })
  it('does not show a previous period payload when the selected period request fails', async () => {
    let sevenDayCalls = 0
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.includes('period=30d')) return jsonResponse(payload(30, 300))
      if (url.includes('period=7d')) {
        sevenDayCalls += 1
        return sevenDayCalls === 1
          ? jsonResponse(payload(7, 70))
          : Promise.resolve(new Response(null, { status: 503 }))
      }
      return jsonResponse({ cardStats: [] })
    })
    render(<DropRateTable />)
    await expectDrawCount(7)
    clickTab('30d')
    await expectDrawCount(30)
    clickTab('comparison')
    await screen.findByText('streamer ranking')
    clickTab('7d')
    await screen.findByText('noData')
    expect(document.querySelector('.text-3xl')).toBeNull()
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/gacha-stats?period=7d',
      '/api/gacha-stats?period=30d',
      '/api/gacha-stats?period=7d',
    ])
  })

  it('ignores a slow response for the previously selected period', async () => {
    let resolveThirtyDay!: (response: Response) => void
    const thirtyDayResponse = new Promise<Response>((resolve) => { resolveThirtyDay = resolve })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.includes('period=30d')) return thirtyDayResponse
      return jsonResponse(payload(7, 70))
    })
    render(<DropRateTable />)
    await expectDrawCount(7)
    clickTab('30d')
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    clickTab('7d')
    await expectDrawCount(7)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await act(async () => {
      resolveThirtyDay(new Response(JSON.stringify(payload(30, 300)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      await thirtyDayResponse
    })
    await waitFor(() => expect(document.querySelector('.text-3xl')?.textContent).toBe('7'))
    expect(document.querySelector('.text-3xl')?.textContent).toBe('7')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
