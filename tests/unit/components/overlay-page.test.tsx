import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import type { GachaBroadcastPayload, RealtimeError, SubscribeOptions } from '@/lib/realtime'
import type { GachaSoundRule } from '@/lib/gacha-sound-rules'
import OverlayPage from '@/app/overlay/[streamerId]/page'
import { pickSoundBearingCardIndex } from '@/lib/gacha-sound-rules'
import { OVERLAY_EFFECT_PARTICLE_CONFIG } from '@/lib/overlay-effect'
import { serializePollState } from '@/lib/overlay-version'

const HISTORY_ID_BEFORE_RELOAD = '00000000-0000-4000-8000-000000000101'
const HISTORY_ID_RESTORED = '00000000-0000-4000-8000-000000000102'

const { subscribeMock, resolvePlayableGachaSoundMock } = vi.hoisted(() => ({
  subscribeMock: vi.fn(),
  // 既定では実装(actual)へ委譲するdelegateとして下のvi.mockファクトリ内で
  // 設定する。個々のテストはmockImplementationOnce()で1回だけ差し替え、
  // それ以外の全テストへは実際のsound-rulesロジックがそのまま使われる。
  resolvePlayableGachaSoundMock: vi.fn(),
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

// Issue #999 レビュー指摘#1回帰用: resolvePlayableGachaSoundだけを差し替え
// 可能にし、pickSoundBearingCardIndex等それ以外のexportは実装のまま使う。
// 「setTimeoutコールバック内でだけ例外を起こす」ことをcard/payloadの
// getterトリックではなく明示的に制御するための部分モック。
vi.mock('@/lib/gacha-sound-rules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gacha-sound-rules')>()
  resolvePlayableGachaSoundMock.mockImplementation(actual.resolvePlayableGachaSound)
  return {
    ...actual,
    resolvePlayableGachaSound: resolvePlayableGachaSoundMock,
  }
})

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
      { id: 'card-1', name: 'Alpha', description: null, image_url: null,
  image_padding_color: null, rarity: 'rare' },
      { id: 'card-2', name: 'Beta', description: null, image_url: null,
  image_padding_color: null, rarity: 'common' },
      { id: 'card-3', name: 'Gamma', description: null, image_url: null,
  image_padding_color: null, rarity: 'legendary' },
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

  it('画像メタデータ取得が停止しても、タイムアウトを待たずN連キューを表示する', async () => {
    vi.useFakeTimers()

    let imageLoadCount = 0
    const imageInstances: MockImage[] = []
    class MockImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      width = 640
      height = 480

      set src(value: string) {
        void value
        imageLoadCount += 1
        imageInstances.push(this)
        // 重いGIFなどでブラウザの画像メタデータ取得が完了しない場合でも、
        // 表示キュー全体を無期限に止めないことがこの回帰テストの対象である。
        // 1・3枚目だけは通常どおりロード完了し、2枚目は意図的に無応答にする。
        if (imageLoadCount !== 2) {
          setTimeout(() => this.onload?.(), 0)
        }
      }
    }
    vi.stubGlobal('Image', MockImage)

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
        card: {
          id: 'card-1', name: 'Alpha', description: null,
          image_url: 'https://example.com/alpha.png', rarity: 'rare',
        },
        cards: [
          {
            id: 'card-1', name: 'Alpha', description: null,
            image_url: 'https://example.com/alpha.png', rarity: 'rare',
          },
          {
            id: 'card-2', name: 'Beta', description: null,
            image_url: 'https://example.com/stalled.gif', rarity: 'common',
          },
          {
            id: 'card-3', name: 'Gamma', description: null,
            image_url: 'https://example.com/gamma.png', rarity: 'legendary',
          },
        ],
        userTwitchUsername: 'Viewer',
      })
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(screen.getByText('Alpha')).toBeInTheDocument()

    // 1枚目の表示終了後、2枚目のmetadata probeは無応答のまま。
    // それでもprobeの1.5秒timeoutを待たず、通常の表示間隔+100msでBetaが
    // 可視になることを固定する。これがIssue #1076の黒画面回帰契約。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6600)
    })
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeVisible()

    // 2枚目のmetadata timeoutの有無とは独立に通常の表示時間で3枚目へ進む。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6600)
    })
    expect(screen.getByText('Gamma')).toBeVisible()

    // タイムアウト済みの2枚目が後から縦長としてロード完了しても、現在の3枚目の
    // レイアウトを変更してはならない。autoPortraitの既定値はtrueなので、古い
    // onload が state を更新すると通常カードの見出し(Gamma)が画像のみ表示に
    // 切り替わって消える。この確認で stale callback の汚染を防ぐ。
    imageInstances[1].width = 100
    imageInstances[1].height = 200
    await act(async () => {
      imageInstances[1].onload?.()
    })
    expect(screen.getByText('Gamma')).toBeInTheDocument()
  })

  // Issue #999調査メモ: 「onerrorが正しく解決されず表示がブロックされて
  // いるのでは」という仮説を検討する過程で追加したテスト。実際には
  // checkImageAspectRatio自体は本Issueの修正で変更しておらず（onerror
  // ハンドラは元から存在し、この仮説は棄却済み）、このテストは本diffの
  // 回帰検出用ではなく「R2/CDN側の画像取得失敗（404・CORS拒否等）で
  // ブラウザが即座に`error`イベントを発火するケースでも、無応答タイム
  // アウトのケースとは別経路として正しく解決されタイムアウトを待たず
  // カード表示へ進む」という既存動作の確認・調査記録として残す。
  it('実画像URLの取得がonerrorで即座に失敗しても、タイムアウトを待たずカードを表示する', async () => {
    vi.useFakeTimers()

    class MockImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      width = 0
      height = 0

      set src(value: string) {
        void value
        // 実際のブラウザがCORS拒否・404等で即座にerrorイベントを発火する
        // 挙動を模擬する（無応答のタイムアウトケースとは別経路）。
        queueMicrotask(() => this.onerror?.())
      }
    }
    vi.stubGlobal('Image', MockImage)

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
        card: {
          id: 'card-real', name: 'RealCard', description: null,
          image_url: 'https://r2.example.com/real-card.png', rarity: 'epic',
        },
        userTwitchUsername: 'Viewer',
      })
    })

    // onerrorはmicrotaskで即座に発火するため、1.5秒のタイムアウトを進めなくても
    // 表示まで到達するはず。タイムアウト直前まで進めても早すぎないことを確認する。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(screen.getByText('RealCard')).toBeInTheDocument()
  })

  // Issue #1076: 接続・イベント受信・演出切り替えは全て成功するのにOBS上で
  // カード画素だけが表示されない(黒画面)事象への対策。next/imageの既定
  // loading="lazy"がOBSブラウザソースで発火しない恐れがあるため即時読み込みに
  // した(詳細な調査経緯・対抗仮説はIssue #1076参照)。通常モード・画像のみ
  // モードの両方の`<Image>`にloading="eager"を適用したことをこの回帰テストで
  // 固定する。
  it.each([
    { label: '通常表示モード', query: '', expectUsernameHeader: true },
    { label: '画像のみモード(imageOnly=true)', query: '?imageOnly=true', expectUsernameHeader: false },
  ])('カード画像はlazy loadingではなく即時読み込みになる($label)(Issue #1076回帰)', async ({ query, expectUsernameHeader }) => {
    window.history.replaceState({}, '', `/overlay/streamer-1${query}`)

    class MockImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      width = 0
      height = 0
      set src(value: string) {
        void value
        // アスペクト比判定の結果自体はこのテストの関心事ではない。既存の
        // 「onerrorで即座に失敗」テスト(上記)と同じ即時失敗パターンに揃え、
        // 1.5秒のタイムアウト待ちを経由せず直接カード表示へ進める。
        queueMicrotask(() => this.onerror?.())
      }
    }
    vi.stubGlobal('Image', MockImage)

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
        card: {
          id: 'card-real', name: 'RealCard', description: null,
          image_url: 'https://r2.example.com/real-card.png', rarity: 'epic',
        },
        userTwitchUsername: 'Viewer',
      })
    })

    const img = await screen.findByAltText('RealCard')
    expect(img).toHaveAttribute('loading', 'eager')

    // レビュー指摘対応: it.eachの2ケースが実際に異なる分岐(通常モード/
    // 画像のみモード)へ到達していることを確認する。通常モードは常にユーザー名
    // 見出し「〜が引いたカード」を表示するが、画像のみモードはpUser未指定
    // (既定false)のため表示しない。imageOnly URLパラメータの解釈が壊れて
    // 常に通常モードへフォールバックしても、この差分が無ければ検知できない。
    if (expectUsernameHeader) {
      expect(screen.getByText(/が引いたカード/)).toBeInTheDocument()
    } else {
      expect(screen.queryByText(/が引いたカード/)).not.toBeInTheDocument()
    }
  })

  // Issue #999: previewの実引き換えで、実イベント受信(`Received payload: gacha`)
  // までは記録されるのにカードが一切画面に表示されない不具合が発生した。
  // processQueue内で想定外の例外（実カードデータ特有の値・画像取得エラー等、
  // 原因は特定できないがコード上あらゆる箇所で起こりうる）が発生すると、
  // 従来はtry/catchが無かったため isDisplayingRef のロックが解放されず、
  // 以後どれだけ実イベントを受信しても enqueueResult() の
  // `if (!isDisplayingRef.current) processQueue()` ガードが常に偽になり、
  // そのOBSセッションが恒久的に沈黙していた（1件でも例外が起きれば、
  // 残り全件が巻き込まれて表示されなくなる）。この回帰を防ぐテスト。
  it('processQueue中に例外が発生してもロックが残らず、後続カードの表示を継続する(Issue #999回帰)', async () => {
    // GitHub自動レビュー指摘: 2枚目が表示されることだけでなく、catchが
    // 実際に通ってhandleQueueErrorの診断ログが出力されたこと自体も固定
    // する（「別経路でたまたま2枚目が出た」という誤検知を防ぐため）。
    window.history.replaceState({}, '', '/overlay/streamer-1?debug=true')

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

    // image_url アクセス時に例外を投げるカード。実データ特有の未知の不具合を
    // 一般化して模擬する（原因箇所を問わず、processQueue中のどの例外でも
    // ロックが残ってはならないことを検証する）。
    const throwingCard = {
      id: 'card-broken',
      name: 'Broken',
      description: null,
      rarity: 'rare',
      get image_url(): string | null {
        throw new Error('unexpected runtime failure');
      },
    };
    act(() => {
      onGachaResult?.({
        type: 'gacha',
        card: throwingCard as unknown as GachaBroadcastPayload['card'],
        userTwitchUsername: 'Viewer',
      });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // catchが実際に通り、handleQueueErrorの診断ログが出力されたことを固定する。
    expect(
      await screen.findByText(/processQueue error: unexpected runtime failure/)
    ).toBeInTheDocument();

    // 1枚目が例外で失敗した後に受信した2枚目。ロックが解放されていれば
    // 通常どおり表示される。
    act(() => {
      onGachaResult?.({
        type: 'gacha',
        card: {
          id: 'card-ok', name: 'Recovered', description: null,
          image_url: null, rarity: 'common',
        },
        userTwitchUsername: 'Viewer',
      });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('Recovered')).toBeInTheDocument();
  });

  // Issue #999 レビュー指摘#1回帰（GitHub自動レビュー・subagentレビュー
  // 双方が指摘): 上のテストは processQueue の外側の try/catch（metadata
  // probe開始〜setResult/setShowCard まで）で捕捉される例外だけを検証していた。
  // しかし setTimeout でスケジュールされる
  // 後半の表示チェーン（音声再生・次カードへの再帰呼び出しを含む）は、
  // それをスケジュールした関数の try/catch の動的スコープに含まれない
  // 別タスクであり、素朴に外側をtry/catchで囲んだだけではその中の例外は
  // 捕捉できない。カード自体のgetterで例外を起こす方式は、
  // rarity/image_url等がReact再レンダー時にも読まれてしまい、setTimeout
  // に到達する前に別経路（レンダー）で先に例外化してしまうため使えない。
  // 代わりに、setTimeoutコールバック内でのみ呼ばれるplayGachaSound経由の
  // resolvePlayableGachaSoundをモックし、1回だけ例外を投げさせることで
  // 「setTimeoutコールバックの中で起きた例外」を確実に再現する。
  it('setTimeoutでスケジュールされる表示チェーン内の例外でもロックが残らない(Issue #999レビュー指摘#1回帰)', async () => {
    vi.useFakeTimers()
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

    // 次にresolvePlayableGachaSoundが呼ばれたときだけ例外を投げる
    // （playGachaSoundはこの呼び出し結果を待たずにthrowを伝播するため、
    // setTimeoutコールバックの中で例外が発生する状況を直接再現できる）。
    resolvePlayableGachaSoundMock.mockImplementationOnce(() => {
      throw new Error('failure inside setTimeout chain')
    })

    act(() => {
      onGachaResult?.({
        type: 'gacha',
        card: { id: 'card-timer-throw', name: 'TimerThrow', description: null, image_url: null, rarity: 'rare' },
        userTwitchUsername: 'Viewer',
      })
    })

    // 100ms後の1段目のsetTimeoutコールバック内でplayGachaSoundが呼ばれ、
    // resolvePlayableGachaSoundが例外を投げる。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(resolvePlayableGachaSoundMock).toHaveBeenCalled()

    // 例外がhandleQueueErrorへ届いていれば、setTimeout(0)経由でロックが
    // 解放され、次のカードが表示されるはず。届いていなければ(=レビュー
    // 指摘の再発)、isDisplayingRefがtrueのまま残り、これは表示されない。
    act(() => {
      onGachaResult?.({
        type: 'gacha',
        card: { id: 'card-ok2', name: 'RecoveredFromTimer', description: null, image_url: null, rarity: 'common' },
        userTwitchUsername: 'Viewer',
      })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(screen.getByText('RecoveredFromTimer')).toBeInTheDocument()
  })

  // Issue #999 レビュー指摘#2回帰: catch側の再継続を同期的な直接呼び出し
  // にすると、同一の例外がキュー内の全アイテムで連続して起きた場合に
  // 同期呼び出しの連鎖でコールスタックを消費し続け、スタックオーバー
  // フローで落ちてロックが解放されないまま終わりうる（実測で約8000件
  // 連続でRangeErrorを確認）。setTimeout(0)でマクロタスクへ逃がして
  // いれば、大量の連続例外でもクラッシュせず、各イテレーションの間に
  // タイマーの巻き戻し（=非同期の一拍）が必要になるはず。ここでは
  // 「タイマーを進めない限り最後まで到達しない」ことを検証することで、
  // 同期再帰ではなくマクロタスク経由の反復になっていることを確認する。
  it('連続する例外がマクロタスク経由で処理され、同期再帰でスタックを消費しない(Issue #999レビュー指摘#2回帰)', async () => {
    vi.useFakeTimers()

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

    const THROWING_COUNT = 50
    const throwingCard = () => ({
      id: 'card-throw', name: 'Throw', description: null, rarity: 'rare',
      get image_url(): string | null {
        throw new Error('always fails');
      },
    })
    const goodCard = {
      id: 'card-final', name: 'FinalSurvivor', description: null,
      image_url: null, rarity: 'common',
    }

    act(() => {
      onGachaResult?.({
        type: 'gacha',
        card: throwingCard() as unknown as GachaBroadcastPayload['card'],
        cards: [
          ...Array.from({ length: THROWING_COUNT }, () => throwingCard() as unknown as GachaBroadcastPayload['card']),
          goodCard,
        ],
        userTwitchUsername: 'Viewer',
      })
    })

    // 同期的な直接再帰なら、この時点(タイマーを一切進めていない)で全50件の
    // 例外処理が呼び出しスタック上で完結してしまうはず。マクロタスク経由
    // なら、1件処理するごとにイベントループへ一度制御を返す必要があるため、
    // タイマーを進めない限り最後のカードまで到達しない。
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByText('FinalSurvivor')).not.toBeInTheDocument()

    // マクロタスクを十分な回数進めれば、クラッシュせずに最後まで到達する。
    // 1msずつ進めるのは、advanceTimersByTimeAsync(0)の繰り返し呼び出しでは
    // 直前の呼び出し中に新規スケジュールされた0ms先のタイマーを後続の
    // 呼び出しが拾わない（フェイクタイマー実装が"今と同時刻"の新規タイマーを
    // 拾わない）ため、クロックを確実に進めて毎回拾わせるための実装都合。
    await act(async () => {
      for (let i = 0; i < THROWING_COUNT + 5; i += 1) {
        await vi.advanceTimersByTimeAsync(1)
      }
    })
    expect(screen.getByText('FinalSurvivor')).toBeInTheDocument()
  })

  // Issue #999の調査メモ: WSコールバックで `Received payload: gacha` は記録
  // されるが、payload.card が無ければ以前は無音で無視され、実機ログだけでは
  // 「cardが来ていないのか」「来ているが表示に失敗しているのか」を判別
  // できなかった。card欠落時に診断ログを残すことを確認する。
  it('gachaペイロードにcardが無い場合、無視するだけでなく診断ログを残す(Issue #999)', async () => {
    window.history.replaceState({}, '', '/overlay/streamer-1?debug=true');

    let onGachaResult: ((payload: GachaBroadcastPayload) => void) | undefined;
    subscribeMock.mockImplementation((_streamerId, callback, options: SubscribeOptions) => {
      onGachaResult = callback as (payload: GachaBroadcastPayload) => void;
      options.onSuccess?.();
      return vi.fn();
    });

    render(<OverlayPage />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      onGachaResult?.({
        type: 'gacha',
        card: undefined as unknown as GachaBroadcastPayload['card'],
        userTwitchUsername: 'Viewer',
        rewardId: 'reward-1',
      });
    });

    expect(
      await screen.findByText(/Gacha payload missing card \(rewardId=reward-1, cardsCount=0\)/)
    ).toBeInTheDocument();
  });

  it('画像メタデータ待機中にunmountすると、タイムアウト後も後続カードを開始しない', async () => {
    vi.useFakeTimers()

    const imageInstances: MockImage[] = []
    class MockImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      width = 640
      height = 480

      set src(value: string) {
        void value
        imageInstances.push(this)
        // 最初のカードだけ通常ロード、2枚目は無応答にしてunmount時の保留状態を作る。
        if (imageInstances.length === 1) {
          setTimeout(() => this.onload?.(), 0)
        }
      }
    }
    vi.stubGlobal('Image', MockImage)

    const playMock = vi.fn().mockResolvedValue(undefined)
    class MockAudio {
      currentTime = 0
      preload = ''
      constructor(src?: string) {
        void src
      }
      play = playMock
      pause = vi.fn()
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

    const view = render(<OverlayPage />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    playMock.mockClear()

    const cards = ['Alpha', 'Beta', 'Gamma'].map((name, index) => ({
      id: `card-${index + 1}`,
      name,
      description: null,
      image_url: `https://example.com/${name.toLowerCase()}.png`,
      rarity: 'rare',
    }))
    act(() => {
      onGachaResult?.({ type: 'gacha', card: cards[0], cards, userTwitchUsername: 'Viewer' })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6600)
    })
    expect(imageInstances).toHaveLength(2)
    const playsBeforeUnmount = playMock.mock.calls.length

    view.unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000)
    })

    // cleanup後に保留タイムアウトが解決しても、3枚目を開始する追加処理・音再生を
    // 行わない。インスタンス数は後続の画像判定が起きていないことの決定的な観測点。
    expect(imageInstances).toHaveLength(2)
    expect(playMock).toHaveBeenCalledTimes(playsBeforeUnmount)
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
      { id: 'card-1', name: 'Alpha', description: null, image_url: null,
  image_padding_color: null, rarity: 'rare' },
      { id: 'card-2', name: 'Beta', description: null, image_url: null,
  image_padding_color: null, rarity: 'common' },
      { id: 'card-3', name: 'Gamma', description: null, image_url: null,
  image_padding_color: null, rarity: 'legendary' },
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
    const RELOAD_COOLDOWN_STORAGE_KEY = 'twica-overlay-reload-v2'
    const POLLSTATE_STORAGE_KEY = 'twica-overlay-pollstate'

    // page.tsx内部のreload時間定数(非export)と同じ値をテスト側でも保持する。
    // 実装側(RELOAD_JITTER_MAX_MS/RELOAD_DEFER_RETRY_MS)を変更した場合は、
    // ここも追随して更新すること。
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
     * disconnected emergency polling(かつsound-settings取得)の共通responseを
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

    it('subscriptionのonOverlayVersionをref経由で処理し、再subscriptionせずreloadする', async () => {
      vi.useFakeTimers()
      vi.spyOn(Math, 'random').mockReturnValue(0)
      const reloadMock = stubLocationReload()
      stubEventsFetch('v-a')
      let onOverlayVersion: SubscribeOptions['onOverlayVersion']
      let onHistoryCursor: SubscribeOptions['onHistoryCursor']

      subscribeMock.mockImplementation((_streamerId, _callback, options: SubscribeOptions) => {
        onOverlayVersion = options.onOverlayVersion
        onHistoryCursor = options.onHistoryCursor
        options.onSuccess?.()
        return vi.fn()
      })

      render(<OverlayPageV />)
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })

      act(() => {
        onHistoryCursor?.({
          redeemedAt: '2026-06-01T00:00:00.123Z',
          historyId: HISTORY_ID_BEFORE_RELOAD,
        })
        onOverlayVersion?.('v-b')
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      expect(reloadMock).toHaveBeenCalledTimes(1)
      expect(subscribeMock).toHaveBeenCalledTimes(1)
      expect(
        JSON.parse(
          sessionStorage.getItem(`${POLLSTATE_STORAGE_KEY}:streamer-1`) ?? '{}'
        )
      ).toMatchObject({
        pollCursor: '2026-06-01T00:00:00.123Z',
        pollHistoryId: HISTORY_ID_BEFORE_RELOAD,
      })
    })

    it('リロード実行後、sessionStorageへ書き込まれるクールダウン記録に既存エントリと新規エントリが両方含まれる(Issue #634、PR #994レビュー指摘#995対応)', async () => {
      // upsertReloadCooldownRecord(cooldownRecords, ...)の第1引数に、実際に
      // sessionStorageから読み取った既存記録を渡し忘れて誤ってnull/[]を渡す
      // ような結線バグが混入しても、純粋関数単体のテストや「クールダウン中は
      // スキップされる」ことしか見ないテストでは検知できない。ここでは実際の
      // リロード実行後にsessionStorageへ書き込まれた内容そのものを検証し、
      // mount前から存在した別バージョン('v-z')の記録が消えずに残ったまま
      // 新規バージョン('v-b')が追記されることを直接確認する。
      vi.useFakeTimers()
      // vi.useFakeTimers()直後のDate.now()はここで凍結される(以降0ms分の
      // advanceしか行わないため、書き込み時刻も同じ値になるはず)。
      // expect.any(Number)ではなく厳密値を検証し、「既存記録を保持しつつ
      // 現在時刻で追記する」ところまで固定する。
      const frozenNow = Date.now()
      vi.spyOn(Math, 'random').mockReturnValue(0)
      const reloadMock = stubLocationReload()
      stubEventsFetch('v-a')

      const existingReloadedAt = frozenNow - 1000
      sessionStorage.setItem(
        RELOAD_COOLDOWN_STORAGE_KEY,
        JSON.stringify([{ version: 'v-z', reloadedAt: existingReloadedAt }]),
      )

      let onOverlayVersion: SubscribeOptions['onOverlayVersion']
      subscribeMock.mockImplementation((_streamerId, _callback, options: SubscribeOptions) => {
        onOverlayVersion = options.onOverlayVersion
        options.onSuccess?.()
        return vi.fn()
      })

      render(<OverlayPageV />)
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })

      act(() => {
        onOverlayVersion?.('v-b')
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      expect(reloadMock).toHaveBeenCalledTimes(1)
      const written = JSON.parse(sessionStorage.getItem(RELOAD_COOLDOWN_STORAGE_KEY) ?? 'null')
      expect(written).toEqual([
        { version: 'v-z', reloadedAt: existingReloadedAt },
        { version: 'v-b', reloadedAt: frozenNow },
      ])
    })

    it('connected中は旧loopを10分以上進めても/eventsへnetwork requestを出さない', async () => {
      vi.useFakeTimers()
      const fetchMock = stubEventsFetch('v-a')
      subscribeMock.mockImplementation((_streamerId, _callback, options: SubscribeOptions) => {
        options.onSuccess?.()
        return vi.fn()
      })

      render(<OverlayPageV />)
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 3_000)
      })

      expect(
        fetchMock.mock.calls.filter(([url]) =>
          String(url).includes('/api/overlay/streamer-1/events')
        )
      ).toHaveLength(0)
      expect(subscribeMock).toHaveBeenCalledTimes(1)
    })

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
        JSON.stringify([{ version: 'v-b', reloadedAt: Date.now() }]),
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

    it('ローリングデプロイの往復で複数バージョンのクールダウン記録がある場合も、該当エントリでリロードがスキップされる(Issue #634)', async () => {
      vi.useFakeTimers()
      vi.spyOn(Math, 'random').mockReturnValue(0.999999)
      const reloadMock = stubLocationReload()

      // A→B→Aと往復した後の状態を模し、直近リロード記録として複数バージョンを
      // 配列で仕込んでおく('v-b'は最新エントリではなく1つ前のエントリ)。
      sessionStorage.setItem(
        RELOAD_COOLDOWN_STORAGE_KEY,
        JSON.stringify([
          { version: 'v-b', reloadedAt: Date.now() },
          { version: 'v-a', reloadedAt: Date.now() },
        ]),
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

    it('mount時にexact pollstateを復元して通常のtransport controllerへ渡す', async () => {
      vi.useFakeTimers()

      const restoredCursor = '2026-06-01T00:00:00.000Z'
      const restoredHistoryId = HISTORY_ID_RESTORED
      sessionStorage.setItem(
        `${POLLSTATE_STORAGE_KEY}:streamer-1`,
        serializePollState({
          pollCursor: restoredCursor,
          pollHistoryId: restoredHistoryId,
          seenHistoryIds: ['h-restored-1'],
          savedAt: Date.now(),
        }),
      )
      stubEventsFetch('v-a')
      let subscriptionOptions: SubscribeOptions | undefined
      subscribeMock.mockImplementation((_streamerId, _callback, options: SubscribeOptions) => {
        subscriptionOptions = options
        options.onSuccess?.()
        return vi.fn()
      })

      render(<OverlayPageV />)

      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(subscriptionOptions?.initialHistoryCursor).toEqual({
        redeemedAt: restoredCursor,
        historyId: restoredHistoryId,
      })
      expect(
        sessionStorage.getItem(`${POLLSTATE_STORAGE_KEY}:streamer-1`)
      ).toBeNull()
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
