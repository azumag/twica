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

  it('Issue #587: confetti は紙吹雪専用アニメーションクラスを使い、旧バグのanimate-bounceを共有しない', async () => {
    vi.useFakeTimers()
    window.history.replaceState({}, '', '/overlay/streamer-1?effect=confetti')

    let onGachaResult: ((payload: GachaBroadcastPayload) => void) | undefined
    subscribeMock.mockImplementation((_streamerId, callback, options: SubscribeOptions) => {
      onGachaResult = callback as (payload: GachaBroadcastPayload) => void
      options.onSuccess?.()
      return vi.fn()
    })

    const { container } = render(<OverlayPage />)

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    act(() => {
      onGachaResult?.({
        type: 'gacha',
        card: { id: 'card-legendary', name: 'Legend', description: null, image_url: null, rarity: 'legendary' },
        userTwitchUsername: 'Viewer',
      })
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })

    // パーティクル数(20個)は変更しない。全て紙吹雪専用クラスを持ち、
    // 旧実装で共有されていたanimate-bounceは一切使わない。
    expect(container.querySelectorAll('.animate-overlay-effect-confetti')).toHaveLength(20)
    expect(container.querySelectorAll('.animate-bounce')).toHaveLength(0)
  })

  it('Issue #587: hearts はハート専用アニメーションクラスを使い、旧バグのanimate-bounceを共有しない', async () => {
    vi.useFakeTimers()
    window.history.replaceState({}, '', '/overlay/streamer-1?effect=hearts')

    let onGachaResult: ((payload: GachaBroadcastPayload) => void) | undefined
    subscribeMock.mockImplementation((_streamerId, callback, options: SubscribeOptions) => {
      onGachaResult = callback as (payload: GachaBroadcastPayload) => void
      options.onSuccess?.()
      return vi.fn()
    })

    const { container } = render(<OverlayPage />)

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    act(() => {
      onGachaResult?.({
        type: 'gacha',
        card: { id: 'card-legendary', name: 'Legend', description: null, image_url: null, rarity: 'legendary' },
        userTwitchUsername: 'Viewer',
      })
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })

    expect(container.querySelectorAll('.animate-overlay-effect-hearts')).toHaveLength(20)
    expect(container.querySelectorAll('.animate-bounce')).toHaveLength(0)
    expect(screen.getAllByText('♥')).toHaveLength(20)
  })

  it('sparkle（デフォルト）は既存のanimate-pingを維持する（回帰防止）', async () => {
    vi.useFakeTimers()
    window.history.replaceState({}, '', '/overlay/streamer-1')

    let onGachaResult: ((payload: GachaBroadcastPayload) => void) | undefined
    subscribeMock.mockImplementation((_streamerId, callback, options: SubscribeOptions) => {
      onGachaResult = callback as (payload: GachaBroadcastPayload) => void
      options.onSuccess?.()
      return vi.fn()
    })

    const { container } = render(<OverlayPage />)

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    act(() => {
      onGachaResult?.({
        type: 'gacha',
        card: { id: 'card-legendary', name: 'Legend', description: null, image_url: null, rarity: 'legendary' },
        userTwitchUsername: 'Viewer',
      })
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })

    expect(container.querySelectorAll('.animate-ping')).toHaveLength(20)
    expect(screen.getAllByText('✨')).toHaveLength(20)
  })

  it('複数の効果音ルールをルールごとにプリロードする', async () => {
    const createdUrls: string[] = []
    class MockAudio {
      src: string
      preload = ''
      currentTime = 0
      constructor(src?: string) {
        this.src = src ?? ''
        if (src) createdUrls.push(src)
      }
      play() {
        return Promise.resolve()
      }
      pause() {}
    }
    vi.stubGlobal('Audio', MockAudio as unknown as typeof Audio)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        soundUrl: 'https://example.com/legacy.mp3',
        soundEnabled: true,
        soundRules: [
          { id: 'r1', url: 'https://example.com/rare.mp3', targetType: 'rarity', rarity: 'rare' },
          { id: 'r2', url: 'https://example.com/legendary.mp3', targetType: 'rarity', rarity: 'legendary' },
        ],
      }),
    }))

    render(<OverlayPage />)

    await waitFor(() => {
      expect(createdUrls).toContain('https://example.com/rare.mp3')
      expect(createdUrls).toContain('https://example.com/legendary.mp3')
      expect(createdUrls).toContain('https://example.com/legacy.mp3')
    })
  })
})
