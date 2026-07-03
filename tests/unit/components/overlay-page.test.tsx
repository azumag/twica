import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import type { GachaBroadcastPayload, RealtimeError, SubscribeOptions } from '@/lib/realtime'
import type { GachaSoundRule } from '@/lib/gacha-sound-rules'
import OverlayPage, { pickSoundBearingCardIndex } from '@/app/overlay/[streamerId]/page'

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

  it('ルールが設定されているのにどれも一致しない場合、レガシーURLへフォールバックせず無音になる（F1b）', async () => {
    const playedSrcs: string[] = []
    class MockAudio {
      currentTime = 0
      preload = ''
      src: string
      constructor(src?: string) { this.src = src ?? '' }
      play() {
        playedSrcs.push(this.src)
        return Promise.resolve()
      }
      pause() {}
    }
    vi.stubGlobal('Audio', MockAudio as unknown as typeof Audio)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        // レガシーミラーURLは存在するが、soundRulesが非空(=このクライアントは
        // ルールベースの音を理解している)なので、一致しなければこちらへは
        // フォールバックしない(F1: サーバー側もcatch-allルールが無ければ
        // このミラーをnullにするが、ここでは overlay 側の判断だけを検証する)。
        soundUrl: 'https://example.com/legacy.mp3',
        soundEnabled: true,
        soundRules: [
          { id: 'reward-only', url: 'https://example.com/reward.mp3', enabled: true, targetType: 'reward', rewardId: 'other-reward' },
        ],
      }),
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

    // プリロード時のアンロック確認 play() 呼び出しをクリアしてから検証する
    playedSrcs.length = 0

    act(() => {
      onGachaResult?.({
        type: 'gacha',
        card: { id: 'card-1', name: 'Alpha', description: null, image_url: null, rarity: 'rare' },
        userTwitchUsername: 'Viewer',
        rewardId: null,
      })
    })

    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument()
    })

    expect(playedSrcs).toHaveLength(0)
  })

  it('N連の効果音は「1枚目」固定ではなく、バッチ内で最も一致度の高いカードで鳴る（F2）', async () => {
    vi.useFakeTimers()

    const playedSrcs: string[] = []
    class MockAudio {
      currentTime = 0
      preload = ''
      src: string
      constructor(src?: string) { this.src = src ?? '' }
      play() {
        playedSrcs.push(this.src)
        return Promise.resolve()
      }
      pause() {}
    }
    vi.stubGlobal('Audio', MockAudio as unknown as typeof Audio)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        soundUrl: null,
        soundEnabled: true,
        // catch-allルールは無く、legendary専用ルールのみ設定されている状態。
        soundRules: [
          { id: 'legendary-rule', url: 'https://example.com/legendary.mp3', enabled: true, targetType: 'rarity', rarity: 'legendary' },
        ],
      }),
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
    playedSrcs.length = 0

    // 1枚目=rare(不一致)、2枚目=common(不一致)、3枚目=legendary(一致)。
    // 従来実装は1枚目基準で音を決めていたため、この並びでは何も鳴らなかった。
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
    expect(playedSrcs).toHaveLength(0)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6600)
    })
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(playedSrcs).toHaveLength(0)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6600)
    })
    expect(screen.getByText('Gamma')).toBeInTheDocument()
    expect(playedSrcs).toEqual(['https://example.com/legendary.mp3'])
  })
})

describe('pickSoundBearingCardIndex (F2)', () => {
  const rule = (overrides: Partial<GachaSoundRule>): GachaSoundRule => ({
    id: 'id',
    url: 'https://example.com/s.mp3',
    enabled: true,
    label: 'L',
    targetType: 'all',
    rarity: null,
    rewardId: null,
    rewardName: null,
    ...overrides,
  })

  it('レガシー設定(ルール空配列)では常に1枚目を代表にする', () => {
    const cards = [{ rarity: 'common' }, { rarity: 'legendary' }]
    expect(pickSoundBearingCardIndex(cards, null, [])).toBe(0)
  })

  it('カードが1枚も無ければ-1を返す', () => {
    expect(pickSoundBearingCardIndex([], null, [])).toBe(-1)
    expect(pickSoundBearingCardIndex([], null, [rule({ targetType: 'all' })])).toBe(-1)
  })

  it('1枚目がコモンでも、後方のレジェンダリーがルールに一致すればそのカードを選ぶ', () => {
    const cards = [{ rarity: 'common' }, { rarity: 'rare' }, { rarity: 'legendary' }]
    const rules = [rule({ id: 'legendary-rule', targetType: 'rarity', rarity: 'legendary' })]
    expect(pickSoundBearingCardIndex(cards, null, rules)).toBe(2)
  })

  it('同じ具体性(rarity)で複数枚が一致する場合、より希少なレアリティのカードを選ぶ', () => {
    const cards = [{ rarity: 'rare' }, { rarity: 'common' }, { rarity: 'legendary' }]
    const rules = [
      rule({ id: 'rare-rule', targetType: 'rarity', rarity: 'rare' }),
      rule({ id: 'legendary-rule', targetType: 'rarity', rarity: 'legendary' }),
    ]
    // index0(rare)は一致するが、index2(legendary)の方が希少なのでそちらが優先される
    // (=1枚目固定ではない、というF2の核心)。
    expect(pickSoundBearingCardIndex(cards, null, rules)).toBe(2)
  })

  it('報酬別ルール(reward)はレアリティ別ルール(rarity)より優先度が高く、reward一致のタイは先頭カードが勝つ', () => {
    // rewardId はカード個別ではなくバッチ(=チャネルポイント引き換え1回)に
    // 紐づく情報のため、reward ルールが一致する場合は「全カードが等しく
    // reward一致」になる(pickGachaSoundRuleがカードのレアリティを見る前に
    // rewardIdだけで確定させるため)。そのため reward 一致時のタイブレークは
    // レアリティではなく先頭カード優先とする(all階層と同じ扱い)。
    const cards = [{ rarity: 'common' }, { rarity: 'legendary' }]
    const rules = [
      rule({ id: 'legendary-rule', targetType: 'rarity', rarity: 'legendary' }),
      rule({ id: 'reward-rule', targetType: 'reward', rewardId: 'reward-1' }),
    ]
    // reward情報が無ければ、rarityルールに一致するindex1(legendary)が選ばれる
    expect(pickSoundBearingCardIndex(cards, null, rules)).toBe(1)
    // 同じルール構成でも、バッチのrewardIdがreward-ruleに一致する場合は
    // reward(優先度最高=3)が全カードに一律で適用されてrarity一致(2)を
    // 上回り、そのタイは先頭のindex0が勝つ(=結果がindex1からindex0へ変わる)。
    expect(pickSoundBearingCardIndex(cards, 'reward-1', rules)).toBe(0)
  })

  it('all(catch-all)ルールしか無い場合は、一致した最初のカードを選ぶ(希少度によるタイブレークはrarity階層限定)', () => {
    const cards = [{ rarity: 'common' }, { rarity: 'rare' }]
    const rules = [rule({ id: 'catch-all', targetType: 'all' })]
    expect(pickSoundBearingCardIndex(cards, null, rules)).toBe(0)
  })

  it('どのカードもルールに一致しなければ-1を返す(ルール非空なら無音、F1bと一貫)', () => {
    const cards = [{ rarity: 'common' }, { rarity: 'rare' }]
    const rules = [rule({ id: 'legendary-rule', targetType: 'rarity', rarity: 'legendary' })]
    expect(pickSoundBearingCardIndex(cards, null, rules)).toBe(-1)
  })
})
