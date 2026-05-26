import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import type { GachaBroadcastPayload, RealtimeError, SubscribeOptions } from '@/lib/realtime'
import OverlayPage from '@/app/overlay/[streamerId]/page'

const { subscribeMock } = vi.hoisted(() => ({
  subscribeMock: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ streamerId: 'streamer-1' }),
}))

vi.mock('@/lib/realtime', () => ({
  subscribeToGachaResults: (
    streamerId: string,
    callback: unknown,
    options: SubscribeOptions,
  ) => subscribeMock(streamerId, callback, options),
}))

const connectionError: RealtimeError = {
  type: 'connection',
  message: 'Realtime connection failed',
  error: null,
  isExpected: false,
}

describe('OverlayPage', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/overlay/streamer-1')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ soundUrl: null, soundEnabled: false }),
    }))
    subscribeMock.mockImplementation((_streamerId, _callback, options: SubscribeOptions) => {
      options.onError?.(connectionError)
      return vi.fn()
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    subscribeMock.mockReset()
  })

  it('通常のOBSオーバーレイでは接続エラーを画面に表示しない', async () => {
    render(<OverlayPage />)

    await waitFor(() => {
      expect(subscribeMock).toHaveBeenCalled()
    })

    expect(subscribeMock.mock.calls[0][2]).toEqual(expect.objectContaining({
      maxRetries: 3,
    }))
    expect(screen.queryByText('接続エラー')).not.toBeInTheDocument()
    expect(screen.queryByText(connectionError.message)).not.toBeInTheDocument()
  })

  it('debug=true の時だけ接続問題をデバッグパネルに表示する', async () => {
    window.history.replaceState({}, '', '/overlay/streamer-1?debug=true')

    render(<OverlayPage />)

    expect(await screen.findByText('Debug Mode - Connection Log')).toBeInTheDocument()
    expect(screen.getByText(`Last issue: ${connectionError.message}`)).toBeInTheDocument()
    expect(screen.queryByText('接続エラー')).not.toBeInTheDocument()
  })

  it('RealtimeのN連ガチャを全カード表示し、効果音は一度だけ再生する', async () => {
    vi.useFakeTimers()

    const playMock = vi.fn().mockResolvedValue(undefined)
    const pauseMock = vi.fn()
    class MockAudio {
      currentTime = 0
      preload = ''

      constructor(public src: string) {}

      play = playMock
      pause = pauseMock
    }

    vi.stubGlobal('Audio', MockAudio)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ soundUrl: 'https://example.com/gacha.mp3', soundEnabled: true }),
    }))

    let onGachaResult: ((payload: GachaBroadcastPayload) => void) | undefined

    subscribeMock.mockImplementation((_streamerId, callback, options: SubscribeOptions) => {
      onGachaResult = callback as (payload: GachaBroadcastPayload) => void
      options.onSuccess?.()
      return vi.fn()
    })

    render(<OverlayPage />)

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(onGachaResult).toBeDefined()
    expect(playMock).toHaveBeenCalledTimes(1)
    playMock.mockClear()

    const cards = [
      { id: 'card-1', name: 'Alpha', description: null, image_url: null, rarity: 'rare' },
      { id: 'card-2', name: 'Beta', description: null, image_url: null, rarity: 'common' },
      { id: 'card-3', name: 'Gamma', description: null, image_url: null, rarity: 'legendary' },
    ]

    act(() => {
      onGachaResult?.({
        type: 'gacha',
        card: cards[0],
        cards,
        userTwitchUsername: 'Viewer',
      })
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(playMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6600)
    })
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(playMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6600)
    })
    expect(screen.getByText('Gamma')).toBeInTheDocument()
    expect(playMock).toHaveBeenCalledTimes(1)
  })

  it('IDのみのRealtime payloadでは詳細APIをbatch取得して全カードを順番に表示する', async () => {
    vi.useFakeTimers()

    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/api/streamer/streamer-1/sound-settings')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ soundUrl: null, soundEnabled: false }),
        })
      }
      if (url.includes('/api/overlay/streamer-1/events')) {
        expect(url).toContain('ids=history-1%2Chistory-2%2Chistory-3')
        return Promise.resolve({
          ok: true,
          json: async () => ({
            complete: true,
            events: [
              {
                id: 'history-1',
                eventId: 'event-1',
                redeemedAt: '2026-05-14T00:00:00.000Z',
                userTwitchUsername: 'Viewer',
                card: { id: 'card-1', name: 'Alpha', description: 'A', image_url: null, rarity: 'rare' },
              },
              {
                id: 'history-2',
                eventId: 'event-1:2',
                redeemedAt: '2026-05-14T00:00:01.000Z',
                userTwitchUsername: 'Viewer',
                card: { id: 'card-2', name: 'Beta', description: 'B', image_url: null, rarity: 'common' },
              },
              {
                id: 'history-3',
                eventId: 'event-1:3',
                redeemedAt: '2026-05-14T00:00:02.000Z',
                userTwitchUsername: 'Viewer',
                card: { id: 'card-3', name: 'Gamma', description: 'C', image_url: null, rarity: 'legendary' },
              },
            ],
          }),
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    let onGachaResult: ((payload: GachaBroadcastPayload) => void) | undefined

    subscribeMock.mockImplementation((_streamerId, callback, options: SubscribeOptions) => {
      onGachaResult = callback as (payload: GachaBroadcastPayload) => void
      options.onSuccess?.()
      return vi.fn()
    })

    render(<OverlayPage />)

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    act(() => {
      onGachaResult?.({
        type: 'gacha',
        historyIds: ['history-1', 'history-2', 'history-3'],
        cardIds: ['card-1', 'card-2', 'card-3'],
        drawCount: 3,
        soundGroupId: 'history-1',
        userTwitchUsername: 'Viewer',
      })
    })

    await act(async () => {
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(screen.getByText('Alpha')).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6600)
    })
    expect(screen.getByText('Beta')).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6600)
    })
    expect(screen.getByText('Gamma')).toBeInTheDocument()
  })

  it('IDのみのRealtime詳細取得が失敗してもpolling cursorを先送りせずfallbackで表示する', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-14T00:00:00.000Z'))

    const pollingSinceValues: string[] = []
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/api/streamer/streamer-1/sound-settings')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ soundUrl: null, soundEnabled: false }),
        })
      }
      if (url.includes('/api/overlay/streamer-1/events')) {
        const parsedUrl = new URL(url)
        if (parsedUrl.searchParams.has('ids')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              complete: false,
              events: [],
            }),
          })
        }

        pollingSinceValues.push(parsedUrl.searchParams.get('since') ?? '')
        return Promise.resolve({
          ok: true,
          json: async () => ({
            events: [
              {
                id: 'history-1',
                eventId: 'event-1',
                redeemedAt: '2026-05-14T00:00:01.000Z',
                userTwitchUsername: 'Viewer',
                card: { id: 'card-1', name: 'Alpha', description: 'A', image_url: null, rarity: 'rare' },
              },
            ],
          }),
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    let onGachaResult: ((payload: GachaBroadcastPayload) => void) | undefined

    subscribeMock.mockImplementation((_streamerId, callback, options: SubscribeOptions) => {
      onGachaResult = callback as (payload: GachaBroadcastPayload) => void
      options.onSuccess?.()
      return vi.fn()
    })

    render(<OverlayPage />)

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    vi.setSystemTime(new Date('2026-05-14T00:00:02.000Z'))
    act(() => {
      onGachaResult?.({
        type: 'gacha',
        historyIds: ['history-1'],
        cardIds: ['card-1'],
        drawCount: 1,
        soundGroupId: 'history-1',
        userTwitchUsername: 'Viewer',
      })
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800)
      await Promise.resolve()
    })
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })

    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(pollingSinceValues.at(-1)).toBe('2026-05-14T00:00:00.000Z')
  })
})
