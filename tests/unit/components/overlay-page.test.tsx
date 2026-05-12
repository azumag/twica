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

  it('RealtimeのN連ガチャpayloadを1枚ずつ順番に表示する', async () => {
    window.history.replaceState({}, '', '/overlay/streamer-1?duration=2')
    let realtimeCallback: ((payload: GachaBroadcastPayload) => void) | undefined
    subscribeMock.mockImplementation((_streamerId, callback, options: SubscribeOptions) => {
      realtimeCallback = callback as (payload: GachaBroadcastPayload) => void
      options.onSuccess?.()
      return vi.fn()
    })

    render(<OverlayPage />)

    await waitFor(() => {
      expect(realtimeCallback).toBeDefined()
    })
    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      realtimeCallback?.({
        type: 'gacha',
        card: {
          id: 'card-1',
          name: 'Alpha',
          description: null,
          image_url: null,
          rarity: 'rare',
        },
        cards: [
          {
            id: 'card-1',
            name: 'Alpha',
            description: null,
            image_url: null,
            rarity: 'rare',
          },
          {
            id: 'card-2',
            name: 'Beta',
            description: null,
            image_url: null,
            rarity: 'common',
          },
        ],
        userTwitchUsername: 'Viewer',
      })
    })

    expect(await screen.findByText('Alpha')).toBeInTheDocument()

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3200))
    })

    expect(await screen.findByText('Beta')).toBeInTheDocument()
  })
})
