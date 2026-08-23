import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import type { GachaBroadcastPayload, SubscribeOptions } from '@/lib/realtime'
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

describe('OverlayPage metadata fallback', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    subscribeMock.mockReset()
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
    act(() => {
      onGachaResult?.({
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
    })

    // metadata timeoutを待つ前からカードDOMは存在する。presentation-onlyな
    // metadata取得がbusiness eventのDOM配置を再びブロックする回帰をここで検知する。
    const cardName = screen.getByText('Metadata Pending')
    const cardRoot = cardName.closest('.transition-all')
    expect(cardRoot).not.toBeNull()
    expect(cardRoot).toHaveClass('opacity-0')

    // load/errorは無応答のままでも、1.5秒のmetadata期限 + 100ms lead-inで可視化される。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600)
    })
    expect(cardRoot).toHaveClass('opacity-100')
  })
})
