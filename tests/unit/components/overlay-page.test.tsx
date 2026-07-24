import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import type { GachaBroadcastPayload, RealtimeError, SubscribeOptions } from '@/lib/realtime'
import type { GachaSoundRule } from '@/lib/gacha-sound-rules'
import OverlayPage from '@/app/overlay/[streamerId]/page'
import { pickSoundBearingCardIndex } from '@/lib/gacha-sound-rules'
import { OVERLAY_EFFECT_PARTICLE_CONFIG } from '@/lib/overlay-effect'
import { serializePollState } from '@/lib/overlay-version'

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

  // #694 Stage 6b: overlayのdebugパネルにmaintenance状態を1行追加した。
  // 通常表示（配信画面）自体には手を入れていないため、通常表示のテストは
  // 既存の「通常のOBSオーバーレイでは接続エラーを画面に表示しない」がそのまま
  // カバーする。ここではdebugパネル固有の追加表示を検証する。
  it('debug=true の時、debugパネルにmaintenance modeを表示する', async () => {
    window.history.replaceState({}, '', '/overlay/streamer-1?debug=true')
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (String(url).includes('/api/maintenance-status')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ mode: 'read-only' }),
          })
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({ soundUrl: null, soundEnabled: false }),
        })
      })
    )

    render(<OverlayPage />)

    expect(await screen.findByText('Debug Mode - Connection Log')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText('Maintenance: read-only')).toBeInTheDocument()
    })
  })

  it('debug=false（デフォルト）のときはmaintenance-status APIを一切呼ばない（サーバー負荷ゼロの設計）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ soundUrl: null, soundEnabled: false }),
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OverlayPage />)

    await waitFor(() => {
      expect(subscribeMock).toHaveBeenCalled()
    })

    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('/api/maintenance-status'))
    ).toBe(false)
  })

  it('ページ分割されたRealtimeのN連を全表示し、soundGroupの効果音は一度だけ再生する', async () => {
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
        cards: cards.slice(0, 2),
        userTwitchUsername: 'Viewer',
        soundGroupId: 'batch-split',
      })
      onGachaResult?.({
        type: 'gacha',
        card: cards[2],
        userTwitchUsername: 'Viewer',
        soundGroupId: 'batch-split',
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

  // エフェクト演出を1枚のカードで発火させる共通ヘルパ
  const renderWithGacha = async (
    search: string,
    card: { id: string; name: string; rarity: string },
  ) => {
    window.history.replaceState({}, '', `/overlay/streamer-1${search}`)

    let onGachaResult: ((payload: GachaBroadcastPayload) => void) | undefined
    subscribeMock.mockImplementation((_streamerId, callback, options: SubscribeOptions) => {
      onGachaResult = callback as (payload: GachaBroadcastPayload) => void
      options.onSuccess?.()
      return vi.fn()
    })

    const view = render(<OverlayPage />)

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    act(() => {
      onGachaResult?.({
        type: 'gacha',
        card: { description: null, image_url: null, ...card },
        userTwitchUsername: 'Viewer',
      })
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })

    return view
  }

  it('confetti は紙吹雪専用アニメーションクラスを使い、旧バグのanimate-bounceを共有しない', async () => {
    vi.useFakeTimers()
    const { container } = await renderWithGacha('?effect=confetti', {
      id: 'card-legendary',
      name: 'Legend',
      rarity: 'legendary',
    })

    // 全て紙吹雪専用クラスを持ち、旧実装で共有されていたanimate-bounceは一切使わない。
    expect(container.querySelectorAll('.animate-overlay-effect-confetti')).toHaveLength(
      OVERLAY_EFFECT_PARTICLE_CONFIG.confetti.particleCount,
    )
    expect(container.querySelectorAll('.animate-bounce')).toHaveLength(0)
  })

  it('hearts はハート専用アニメーションクラスを使い、♥グリフを表示する', async () => {
    vi.useFakeTimers()
    const { container } = await renderWithGacha('?effect=hearts', {
      id: 'card-legendary',
      name: 'Legend',
      rarity: 'legendary',
    })

    const heartCount = OVERLAY_EFFECT_PARTICLE_CONFIG.hearts.particleCount
    expect(container.querySelectorAll('.animate-overlay-effect-hearts')).toHaveLength(heartCount)
    expect(container.querySelectorAll('.animate-bounce')).toHaveLength(0)
    expect(screen.getAllByText('♥')).toHaveLength(heartCount)
  })

  it('sparkle（デフォルト）は専用キラキラアニメーションクラスで描画される', async () => {
    vi.useFakeTimers()
    const { container } = await renderWithGacha('', {
      id: 'card-legendary',
      name: 'Legend',
      rarity: 'legendary',
    })

    expect(container.querySelectorAll('.animate-overlay-effect-sparkle')).toHaveLength(
      OVERLAY_EFFECT_PARTICLE_CONFIG.sparkle.particleCount,
    )
    // 旧実装の animate-ping には依存しない
    expect(container.querySelectorAll('.animate-ping')).toHaveLength(0)
  })

  it('レアリティ別: 既定では legendary 以外にエフェクトを出さない（従来挙動の維持）', async () => {
    vi.useFakeTimers()
    const { container } = await renderWithGacha('', {
      id: 'card-common',
      name: 'Common',
      rarity: 'common',
    })

    // common は既定 "none" のためパーティクルは一切描画されない
    expect(container.querySelectorAll('[class*="animate-overlay-effect-"]')).toHaveLength(0)
  })

  it('レアリティ別: fx= でレアリティごとに別々のエフェクトを割り当てられる', async () => {
    vi.useFakeTimers()
    // epic には confetti、legendary には fireworks を割り当てる
    const { container } = await renderWithGacha('?fx=epic:confetti,legendary:fireworks', {
      id: 'card-epic',
      name: 'Epic',
      rarity: 'epic',
    })

    // epic カードなので confetti のみが描画される
    expect(container.querySelectorAll('.animate-overlay-effect-confetti')).toHaveLength(
      OVERLAY_EFFECT_PARTICLE_CONFIG.confetti.particleCount,
    )
    expect(container.querySelectorAll('.animate-overlay-effect-fireworks')).toHaveLength(0)
  })

  it('effects=false のときは legendary でもエフェクトを出さない', async () => {
    vi.useFakeTimers()
    const { container } = await renderWithGacha('?effects=false&effect=fireworks', {
      id: 'card-legendary',
      name: 'Legend',
      rarity: 'legendary',
    })

    expect(container.querySelectorAll('[class*="animate-overlay-effect-"]')).toHaveLength(0)
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
    })
    // Issue #638: soundRulesが非空の場合、レガシー単一URLは再生ロジック
    // (resolvePlayableGachaSound)上そもそも使われないため、プリロードもしない
    // (無駄なリクエストを避ける)。
    expect(createdUrls).not.toContain('https://example.com/legacy.mp3')
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

  it('Issue #638の再現・修正確認: レアリティ限定ルールのみ設定(soundEnabledミラーはfalse)でも一致すれば効果音が鳴る', async () => {
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
        // PR #595 F1により、catch-allルールが無い設定ではサーバーはミラーを
        // soundUrl: null / soundEnabled: false で返す。ここで soundEnabled を
        // 再生ゲートに使うと(#638の回帰)、rarity限定ルールがあっても無音になる。
        soundUrl: null,
        soundEnabled: false,
        soundRules: [
          { id: 'rare-rule', url: 'https://example.com/rare.mp3', enabled: true, targetType: 'rarity', rarity: 'rare' },
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

    act(() => {
      onGachaResult?.({
        type: 'gacha',
        card: { id: 'card-1', name: 'Alpha', description: null, image_url: null, rarity: 'rare' },
        userTwitchUsername: 'Viewer',
      })
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(playedSrcs).toEqual(['https://example.com/rare.mp3'])
  })

  // Issue #569 厳格レビュー指摘(High): attemptReload / checkOverlayVersion /
  // mount時pollstate復元は、テスト環境では page.tsx トップレベルの
  // `CURRENT_OVERLAY_VERSION = process.env.NEXT_PUBLIC_OVERLAY_VERSION ?? "dev"`
  // が常に 'dev' に評価される(tests/setup.tsで当該環境変数を設定していない)ため、
  // shouldScheduleReloadが常にfalseを返し、通常のOverlayPageインポートでは
  // この経路が一度も実行されない。
  // vi.stubEnv + vi.resetModules + 動的importで「'dev'ではないビルド」を
  // このdescribe専用に用意し、実際に不一致検出→ジッター待機→リロードの
  // 経路を駆動して検証する。
  describe('Issue #569: バージョン不一致検出とアイドル時自動リロード', () => {
    // window.location を丸ごと差し替えるため、テストごとに元のLocationへ
    // 復元する(そうしないと以降のテスト・describeでwindow.history.replaceState
    // との整合が壊れる)
    const originalLocation = window.location
    let OverlayPageV: typeof OverlayPage

    // page.tsx の RELOAD_COOLDOWN_STORAGE_KEY / POLLSTATE_STORAGE_KEY は
    // overlay-version.tsの純粋関数群とは異なりpage.tsx内部の実装詳細のため
    // 非exportになっている。ここでは実装と同じリテラル値を直接指定する
    // (page.tsx側でキー名を変更した場合はこのテストも追随して更新が必要)。
    const RELOAD_COOLDOWN_STORAGE_KEY = 'twica-overlay-reload'
    const POLLSTATE_STORAGE_KEY = 'twica-overlay-pollstate'

    // page.tsx内部の時間定数(非export)と同じ値をテスト側でも保持する。
    // 実装側(VERSION_CHECK_INTERVAL_MS/RELOAD_JITTER_MAX_MS/RELOAD_DEFER_RETRY_MS)
    // を変更した場合は、ここも追随して更新すること。
    const RELOAD_JITTER_MAX_MS = 10 * 60 * 1000
    const RELOAD_DEFER_RETRY_MS = 30 * 1000

    beforeAll(async () => {
      // CURRENT_OVERLAY_VERSION はモジュールのトップレベルで一度だけ評価される
      // ため、'dev'以外の値にするには「環境変数スタブ→モジュールキャッシュ破棄→
      // 再import」が必要になる。ファイル先頭で静的importした既存の OverlayPage
      // はこの後も'dev'ビルドのまま維持される(他のテストへは影響しない)。
      vi.stubEnv('NEXT_PUBLIC_OVERLAY_VERSION', 'v-a')
      vi.resetModules()
      const mod = await import('@/app/overlay/[streamerId]/page')
      OverlayPageV = mod.default
    })

    afterAll(() => {
      vi.unstubAllEnvs()
    })

    beforeEach(() => {
      // cooldown/pollstateの仕込みがテスト間で残らないようにする
      sessionStorage.clear()
    })

    afterEach(() => {
      // Math.randomスパイ等をテストごとに元へ戻す
      vi.restoreAllMocks()
      // window.locationを元のLocationオブジェクトへ戻す
      Object.defineProperty(window, 'location', { value: originalLocation, configurable: true })
    })

    /**
     * location.reloadをスパイに差し替える(既存のLocationプロパティは維持する)。
     * 注意: happy-domのLocationはhref/origin/search等をprototype上のgetterとして
     * 実装しており、いずれもインスタンス自身のenumerableプロパティではない。
     * そのため `{ ...window.location }` は何もフィールドをコピーできず
     * (origin等がundefinedになり、page.tsx内の `new URL(path, location.origin)`
     * がInvalid URLで例外を投げてしまう)、各プロパティをgetter経由で明示的に
     * 読み出してコピーする必要がある。
     */
    const stubLocationReload = () => {
      const reloadMock = vi.fn()
      const current = window.location
      Object.defineProperty(window, 'location', {
        value: {
          hash: current.hash,
          host: current.host,
          hostname: current.hostname,
          href: current.href,
          origin: current.origin,
          pathname: current.pathname,
          port: current.port,
          protocol: current.protocol,
          search: current.search,
          reload: reloadMock,
        },
        configurable: true,
      })
      return reloadMock
    }

    /**
     * overlay events ポーリング(かつsound-settings取得)の共通fetchレスポンスを
     * 組み立てる。このテストファイルの既存の流儀(fetchはURLを区別せず単一の
     * レスポンス形状を返す)に合わせ、events/overlayVersionとsoundUrl/soundEnabled
     * を同居させる。
     */
    const stubEventsFetch = (overlayVersion: string) => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          soundUrl: null,
          soundEnabled: false,
          events: [],
          overlayVersion,
        }),
      })
      vi.stubGlobal('fetch', fetchMock)
      return fetchMock
    }

    it('フォールバックポーリングでoverlayVersion不一致を検出し、ジッター上限まで進めるとlocation.reloadが呼ばれる', async () => {
      vi.useFakeTimers()
      // ジッターを上限近くに固定し、「上限まで進めれば必ず発火する」ことを検証する
      vi.spyOn(Math, 'random').mockReturnValue(0.999999)
      const reloadMock = stubLocationReload()
      stubEventsFetch('v-b')

      render(<OverlayPageV />)

      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })

      // 最初のフォールバックポーリング(3秒後)でoverlayVersion不一致を検出し、
      // ジッター待機(setTimeout)をスケジュールする
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })
      expect(reloadMock).not.toHaveBeenCalled()

      // ジッター上限まで進めると、スケジュールされたリロードが実行される
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RELOAD_JITTER_MAX_MS)
      })
      expect(reloadMock).toHaveBeenCalledTimes(1)
    })

    it('演出中(showCard)にジッターが発火した場合は即座にreloadされず、演出終了後に呼ばれる', async () => {
      vi.useFakeTimers()
      // ジッターをほぼ0にして、最初のポーリング直後に発火させる
      vi.spyOn(Math, 'random').mockReturnValue(0)
      const reloadMock = stubLocationReload()
      stubEventsFetch('v-b')

      let onGachaResult: ((payload: GachaBroadcastPayload) => void) | undefined
      subscribeMock.mockImplementation((_streamerId, callback, options: SubscribeOptions) => {
        onGachaResult = callback as (payload: GachaBroadcastPayload) => void
        options.onError?.(connectionError)
        return vi.fn()
      })

      render(<OverlayPageV />)

      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })

      // カードを表示させ、演出中(showCard=true)の状態を作る
      act(() => {
        onGachaResult?.({
          type: 'gacha',
          card: { id: 'card-1', name: 'Alpha', description: null, image_url: null, rarity: 'rare' },
          userTwitchUsername: 'Viewer',
        })
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100)
      })
      expect(screen.getByText('Alpha')).toBeInTheDocument()

      // 3秒後のポーリングでバージョン不一致を検出。ジッターはほぼ0のため直後に
      // 発火するが、演出中(showCard=true)のため即座にはreloadされない
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })
      expect(reloadMock).not.toHaveBeenCalled()

      // 演出のhide(6秒後)・クリア(その0.5秒後)を別々のactで個別にflushしてから
      // 残りの再試行間隔を進める。ここを1回の巨大なadvanceTimersByTimeAsyncに
      // まとめると、setShowCard(false)によるReact状態更新がshowCardRefへ
      // ミラーされる(useEffect)前に再試行タイマーの判定が実行されてしまい、
      // 「演出はとっくに終わっているのにshowCardRef.currentがstaleなtrueのまま」
      // という誤検知でテストが不安定になることを確認済み(fake timers配下で
      // 大量のタイマーを一度に進めた際のReactバッチング起因)。
      // 演出終了の前後で明示的にactの区切りを入れ、Reactに反映の機会を与える。
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000) // 表示から6秒後: hideタイマー発火(showCard: true→false)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000) // さらに0.5秒後: クリアタイマー発火(result: null、isDisplaying: false)
      })
      expect(reloadMock).not.toHaveBeenCalled()

      // 演出(表示6秒+後片付け0.5秒)は既に終わっているはずなので、演出中の
      // 再試行間隔(30秒)が経過すると今度はreloadが呼ばれる
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RELOAD_DEFER_RETRY_MS - 4000)
      })
      expect(reloadMock).toHaveBeenCalledTimes(1)
    })

    it('同一バージョンのクールダウン記録がsessionStorageにある場合、リロードはスキップされる', async () => {
      vi.useFakeTimers()
      vi.spyOn(Math, 'random').mockReturnValue(0.999999)
      const reloadMock = stubLocationReload()

      // mount前に、これから検出する予定のバージョン'v-b'に対する直近リロード
      // 記録を仕込んでおく(60分クールダウン中なのでスキップされるはず)
      sessionStorage.setItem(
        RELOAD_COOLDOWN_STORAGE_KEY,
        JSON.stringify({ version: 'v-b', reloadedAt: Date.now() }),
      )
      stubEventsFetch('v-b')

      render(<OverlayPageV />)

      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RELOAD_JITTER_MAX_MS)
      })

      expect(reloadMock).not.toHaveBeenCalled()
    })

    it('mount時にsessionStorageのpollstateスナップショットを復元し、次のポーリングのsinceに反映する', async () => {
      vi.useFakeTimers()

      const restoredCursor = '2026-06-01T00:00:00.000Z'
      sessionStorage.setItem(
        POLLSTATE_STORAGE_KEY,
        serializePollState({
          pollCursor: restoredCursor,
          seenHistoryIds: ['h-restored-1'],
          savedAt: Date.now(),
        }),
      )
      // このテストはpollstate復元のみに関心があるため、overlayVersionは現行
      // ビルド('v-a')と一致させリロード関連の副作用を起こさないようにする
      const fetchMock = stubEventsFetch('v-a')

      render(<OverlayPageV />)

      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })

      const eventsCall = fetchMock.mock.calls.find(([url]) =>
        String(url).includes('/api/overlay/streamer-1/events'),
      )
      expect(eventsCall).toBeDefined()
      const requestedUrl = new URL(String(eventsCall?.[0]))
      expect(requestedUrl.searchParams.get('since')).toBe(restoredCursor)
    })
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
