import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import type { GachaBroadcastPayload, GachaDeliveryResult, SubscribeOptions } from '@/lib/realtime'
import OverlayPage from '@/app/overlay/[streamerId]/page'

const { subscribeMock, streamerIdRef } = vi.hoisted(() => ({
  subscribeMock: vi.fn(),
  streamerIdRef: { current: 'streamer-1' },
}))

// metadata callback が無応答のままでも表示が維持されることを見る観測窓。
// 現行の 1.5 秒 probe timeout を少し越えて待つ意図を数値直書きから分離する。
const METADATA_STALL_OBSERVATION_MS = 1_600

vi.mock('next/navigation', () => ({
  useParams: () => ({ streamerId: streamerIdRef.current }),
}))

vi.mock('@/lib/realtime', () => ({
  subscribeToGachaResults: (
    streamerId: string,
    callback: unknown,
    options: SubscribeOptions,
  ) => subscribeMock(streamerId, callback, options),
}))

describe('OverlayPage metadata fallback', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    subscribeMock.mockReset()
    streamerIdRef.current = 'streamer-1'
  })

  it('購読開始と同じタスクで届いたpayloadもカードDOMへ渡す', async () => {
    window.history.replaceState({}, '', '/overlay/streamer-1')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ soundUrl: null, soundEnabled: false }),
    }))

    subscribeMock.mockImplementation((_streamerId, callback, options: SubscribeOptions) => {
      // A DO welcome/recovery frame can synchronously flush a queued event while
      // subscribeToGachaResults is still returning. The page must not depend on
      // a later user gesture or a second polling pass to render it.
      const onPayload = callback as (payload: GachaBroadcastPayload) => GachaDeliveryResult
      onPayload({
        type: 'gacha',
        card: {
          id: 'synchronous-card',
          name: 'Synchronous Card',
          description: null,
          image_url: null,
          rarity: 'common',
        },
        userTwitchUsername: 'Viewer',
      })
      options.onSuccess?.()
      return vi.fn()
    })

    render(<OverlayPage />)
    expect(await screen.findByText('Synchronous Card')).toBeInTheDocument()
    expect(screen.getByText('Synchronous Card').closest('[data-overlay-card="true"]'))
      .toHaveClass('opacity-100')
  })

  // #1076 の実経路では gacha payload を受信しても最初のカードDOM自体が出ない症状が
  // あった。既存のN連キューテストとは分け、初回カードでブラウザの metadata callback が
  // 一度も返らなくても business event のDOM配置と期限後のrevealが進むことを固定する。
  it('初回カードのmetadata callbackが無応答でもDOMを先に配置して表示する', async () => {
    vi.useFakeTimers()
    window.history.replaceState({}, '', '/overlay/streamer-1')

    class PendingImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      width = 640
      height = 480

      set src(value: string) {
        void value
        // ブラウザ由来の load / error を意図的に発火させない。
      }
    }
    vi.stubGlobal('Image', PendingImage)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ soundUrl: null, soundEnabled: false }),
    }))

    let onGachaResult: ((payload: GachaBroadcastPayload) => GachaDeliveryResult) | undefined
    let acknowledged = false
    subscribeMock.mockImplementation((_streamerId, callback, options: SubscribeOptions) => {
      onGachaResult = callback as (payload: GachaBroadcastPayload) => GachaDeliveryResult
      options.onSuccess?.()
      return vi.fn()
    })

    render(<OverlayPage />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(onGachaResult).toBeDefined()
    act(() => {
      const delivery = onGachaResult?.({
        type: 'gacha',
        card: {
          id: 'metadata-pending-card',
          name: 'Metadata Pending',
          description: null,
          image_url: 'https://example.com/metadata-pending.png',
          rarity: 'rare',
        },
        userTwitchUsername: 'Viewer',
      })
      expect(delivery).toBeInstanceOf(Promise)
      void Promise.resolve(delivery).then((accepted) => {
        acknowledged = accepted === true
      })
      expect(acknowledged).toBe(false)
    })

    // metadata timeoutを待つ前からカードDOMは存在し、すでに可視である。
    // presentation-onlyなmetadata取得やrevealタイマーがbusiness eventの
    // 表示を再びブロックする回帰をここで検知する。
    const cardName = screen.getByText('Metadata Pending')
    const cardRoot = cardName.closest('.transition-all')
    expect(cardRoot).not.toBeNull()
    expect(cardRoot).toHaveClass('opacity-100')
    const cardImage = cardRoot?.querySelector('img') as HTMLImageElement | null
    if (cardImage) {
      Object.defineProperty(cardImage, 'complete', { configurable: true, value: true })
      Object.defineProperty(cardImage, 'naturalWidth', { configurable: true, value: 320 })
      Object.defineProperty(cardImage, 'naturalHeight', { configurable: true, value: 448 })
      cardImage.dispatchEvent(new Event('load'))
    }

    // load/errorは無応答のままでも、metadata期限に依存せず表示が維持される。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(METADATA_STALL_OBSERVATION_MS)
    })
    expect(cardRoot).toHaveClass('opacity-100')
    expect(acknowledged).toBe(true)
  })

  it('旧subscription世代の遅延payloadを新しいstreamerへ混ぜない', async () => {
    window.history.replaceState({}, '', '/overlay/streamer-1')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ soundUrl: null, soundEnabled: false }),
    }))

    const callbacks: Array<(payload: GachaBroadcastPayload) => GachaDeliveryResult> = []
    subscribeMock.mockImplementation((_streamerId, callback, options: SubscribeOptions) => {
      callbacks.push(callback as (payload: GachaBroadcastPayload) => GachaDeliveryResult)
      options.onSuccess?.()
      return vi.fn()
    })

    const { rerender } = render(<OverlayPage />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    streamerIdRef.current = 'streamer-2'
    rerender(<OverlayPage />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(callbacks).toHaveLength(2)
    let staleResult: GachaDeliveryResult
    act(() => {
      staleResult = callbacks[0]({
        type: 'gacha',
        card: { id: 'stale', name: 'Stale Card', description: null, image_url: null, rarity: 'common' },
        userTwitchUsername: 'Viewer',
      })
    })
    expect(await Promise.resolve(staleResult!)).toBe(false)
    let currentResult: GachaDeliveryResult
    act(() => {
      currentResult = callbacks[1]({
        type: 'gacha',
        card: { id: 'current', name: 'Current Card', description: null, image_url: null, rarity: 'common' },
        userTwitchUsername: 'Viewer',
      })
    })
    expect(await Promise.resolve(currentResult!)).toBe(true)
    expect(screen.queryByText('Stale Card')).not.toBeInTheDocument()
    expect(screen.getByText('Current Card')).toBeInTheDocument()
  })
})
