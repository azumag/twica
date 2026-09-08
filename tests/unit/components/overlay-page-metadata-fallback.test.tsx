import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import type { GachaBroadcastPayload, GachaDeliveryResult, SubscribeOptions } from '@/lib/realtime'
import OverlayPage from '@/app/overlay/[streamerId]/page'

const { subscribeMock, streamerIdRef } = vi.hoisted(() => ({
  subscribeMock: vi.fn(),
  streamerIdRef: { current: 'streamer-1' },
}))

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

  it.each(['load', 'timeout', 'error', 'decode-error', 'decode-timeout'] as const)(
    '画像準備待ちでは枠を表示せず、%s 後から表示時間を数える', async (outcome) => {
      vi.useFakeTimers()
      window.history.replaceState({}, '', '/overlay/streamer-1?duration=2')
      const pendingImages: PendingImage[] = []
      let finishDecode: (() => void) | undefined
      class PendingImage {
        onload: (() => void) | null = null
        onerror: (() => void) | null = null
        width = 640
        height = 480
        decode = () => outcome === 'decode-error'
          ? Promise.reject(new Error('invalid image'))
          : new Promise<void>(resolve => { finishDecode = resolve })
        set src(_value: string) { pendingImages.push(this) }
      }
      vi.stubGlobal('Image', PendingImage)
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: async () => ({ soundUrl: null, soundEnabled: false }),
      }))
      let onPayload: ((payload: GachaBroadcastPayload) => GachaDeliveryResult) | undefined
      subscribeMock.mockImplementation((_id, callback, options: SubscribeOptions) => {
        onPayload = callback
        options.onSuccess?.()
        return vi.fn()
      })
      render(<OverlayPage />)
      await act(async () => { await Promise.resolve() })
      await act(async () => {
        void onPayload?.({
          type: 'gacha',
          card: { id: 'waiting', name: 'Waiting Card', description: null,
            image_url: 'https://example.com/waiting.png', rarity: 'rare' },
          userTwitchUsername: 'Viewer',
        })
      })
      expect(screen.queryByText('Waiting Card')).not.toBeInTheDocument()
      await act(async () => { await vi.advanceTimersByTimeAsync(800) })
      expect(screen.queryByText('Waiting Card')).not.toBeInTheDocument()
      if (outcome === 'timeout') {
        await act(async () => { await vi.advanceTimersByTimeAsync(800) })
      } else if (outcome === 'error') {
        await act(async () => { pendingImages[0]?.onerror?.() })
      } else {
        await act(async () => { pendingImages[0]?.onload?.() })
        if (outcome === 'decode-timeout') {
          await act(async () => { await vi.advanceTimersByTimeAsync(800) })
        }
        if (outcome === 'load') {
          expect(screen.queryByText('Waiting Card')).not.toBeInTheDocument()
          await act(async () => { finishDecode?.() })
        }
      }
      const root = screen.getByText('Waiting Card').closest('[data-overlay-card="true"]')!
      expect(root).toHaveClass('opacity-100')
      if (outcome !== 'load') {
        expect(root.querySelector('[data-overlay-card-fallback="true"]')).not.toBeNull()
      } else {
        // The real element, rather than the detached preloader, owns delivery ACK.
        const image = root.querySelector('img')!
        Object.defineProperties(image, {
          complete: { configurable: true, value: true },
          naturalWidth: { configurable: true, value: 320 },
          naturalHeight: { configurable: true, value: 448 },
        })
        await act(async () => { image.dispatchEvent(new Event('load')) })
      }
      await act(async () => { await vi.advanceTimersByTimeAsync(800) })
      expect(root).toHaveClass('opacity-100')
      await act(async () => { await vi.advanceTimersByTimeAsync(1400) })
      expect(root).toHaveClass('opacity-0')
    },
  )

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
