import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import {
  MaintenanceStatusProvider,
  useMaintenanceStatus,
} from '@/components/MaintenanceStatusProvider'

// useMaintenanceStatus() の戻り値を画面に出すだけの最小消費コンポーネント。
// 各書き込みボタン（CardManager等）が実際に使うのと同じ hook 経由で検証する。
function StatusProbe() {
  const status = useMaintenanceStatus()
  return (
    <div>
      <span data-testid="mode">{status.mode}</span>
      <span data-testid="expected-end-at">{status.expectedEndAt ?? ''}</span>
      <span data-testid="write-blocked">{String(status.mode !== 'off')}</span>
      <span data-testid="refreshing">{String(status.isRefreshing === true)}</span>
    </div>
  )
}

describe('MaintenanceStatusProvider', () => {
  let visibilityState: DocumentVisibilityState

  beforeEach(() => {
    visibilityState = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
      () => visibilityState
    )
  })

  afterEach(() => {
    // Providerのeffect cleanup（interval解除・visibility listener解除）を、
    // getter spyやfake timerを復元する前に必ず実行する。テスト間でDOMと
    // Providerの状態を残さないことが、fetch回数やgetByTestIdの累積を防ぐ。
    cleanup()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('Provider の外で useMaintenanceStatus() を呼ぶと安全側のoffを返す（例外にしない）', () => {
    render(<StatusProbe />)
    expect(screen.getByTestId('mode')).toHaveTextContent('off')
  })

  it('初期visible mountは既存のoff契約を保って即時fetchし、取得したstatusを配る', async () => {
    let resolveFetch!: (response: Response) => void
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve
    })
    const fetchMock = vi.fn().mockReturnValue(fetchPromise)
    vi.stubGlobal('fetch', fetchMock)

    render(
      <MaintenanceStatusProvider>
        <StatusProbe />
      </MaintenanceStatusProvider>
    )

    // 初期mountはProvider外と同じOFF_STATUS契約を維持する。サーバー側guardWriteが
    // 最終防御を担うため、hidden復帰向けの一時read-onlyはここへ波及させない。
    expect(screen.getByTestId('mode')).toHaveTextContent('off')
    expect(screen.getByTestId('write-blocked')).toHaveTextContent('false')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    resolveFetch(new Response(
      JSON.stringify({ mode: 'read-only', expectedEndAt: '2026-07-20T00:00:00.000Z' }),
      { status: 200 }
    ))

    await waitFor(() => {
      expect(screen.getByTestId('mode')).toHaveTextContent('read-only')
    })
    expect(screen.getByTestId('expected-end-at')).toHaveTextContent('2026-07-20T00:00:00.000Z')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/maintenance-status',
      expect.objectContaining({ cache: 'no-store' })
    )
  })

  it('hiddenからvisibleへの復帰確認中はwriteを無効化し、解決後のread-onlyを反映する', async () => {
    let resolveRefresh!: (response: Response) => void
    const refreshPromise = new Promise<Response>((resolve) => {
      resolveRefresh = resolve
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ mode: 'off' }), { status: 200 }))
      .mockReturnValueOnce(refreshPromise)
    vi.stubGlobal('fetch', fetchMock)

    render(
      <MaintenanceStatusProvider>
        <StatusProbe />
      </MaintenanceStatusProvider>
    )

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('mode')).toHaveTextContent('off')
    })

    visibilityState = 'hidden'
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    visibilityState = 'visible'
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    // 復帰fetchのPromiseが未解決でも、全consumerと同じ `mode !== 'off'`
    // 判定でwrite不可になる。hidden前の古いoffを再確認中に公開しない。
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('mode')).toHaveTextContent('read-only')
    expect(screen.getByTestId('write-blocked')).toHaveTextContent('true')
    expect(screen.getByTestId('refreshing')).toHaveTextContent('true')
    expect(screen.getByTestId('expected-end-at')).toBeEmptyDOMElement()

    resolveRefresh(new Response(
      JSON.stringify({
        mode: 'read-only',
        expectedEndAt: '2026-08-09T12:00:00.000Z',
      }),
      { status: 200 }
    ))

    await waitFor(() => {
      expect(screen.getByTestId('mode')).toHaveTextContent('read-only')
      expect(screen.getByTestId('expected-end-at')).toHaveTextContent(
        '2026-08-09T12:00:00.000Z'
      )
      expect(screen.getByTestId('refreshing')).toHaveTextContent('false')
    })
  })

  it('初期hiddenから最初にvisibleになった再確認中も暫定状態を識別できる', async () => {
    let resolveFetch!: (response: Response) => void
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve
    })
    const fetchMock = vi.fn().mockReturnValue(fetchPromise)
    vi.stubGlobal('fetch', fetchMock)
    visibilityState = 'hidden'

    render(
      <MaintenanceStatusProvider>
        <StatusProbe />
      </MaintenanceStatusProvider>
    )
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('mode')).toHaveTextContent('off')

    visibilityState = 'visible'
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('mode')).toHaveTextContent('read-only')
    expect(screen.getByTestId('write-blocked')).toHaveTextContent('true')
    expect(screen.getByTestId('refreshing')).toHaveTextContent('true')

    resolveFetch(new Response(JSON.stringify({ mode: 'off' }), { status: 200 }))
    await waitFor(() => {
      expect(screen.getByTestId('mode')).toHaveTextContent('off')
      expect(screen.getByTestId('refreshing')).toHaveTextContent('false')
    })
  })

  it('60秒間隔でポーリングし、状態変化がcontext消費者に反映される', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ mode: 'off' }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ mode: 'incident-read-only' }), { status: 200 })
      )
    vi.stubGlobal('fetch', fetchMock)

    render(
      <MaintenanceStatusProvider>
        <StatusProbe />
      </MaintenanceStatusProvider>
    )

    // 初回fetch分
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByTestId('mode')).toHaveTextContent('off')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // 60秒未満では2回目のfetchが発生しない（低頻度ポーリングであることの確認）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_000)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // 60秒経過で2回目のポーリングが発生し、状態が更新される
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('mode')).toHaveTextContent('incident-read-only')
  })

  it('hidden中は停止し、visible復帰時に即時fetchして単一の60秒pollを再開する', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ mode: 'off' }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)

    visibilityState = 'hidden'
    render(
      <MaintenanceStatusProvider>
        <StatusProbe />
      </MaintenanceStatusProvider>
    )

    // 初期状態がhiddenなら、mount直後のfetchもpollingも開始しない。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(fetchMock).toHaveBeenCalledTimes(0)

    visibilityState = 'visible'
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    visibilityState = 'hidden'
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000)
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    visibilityState = 'visible'
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
      // Duplicate visible notifications must not create another immediate
      // request or a second interval.
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_999)
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('hidden前の遅いresponseがvisible復帰後の新しいstatusを上書きしない', async () => {
    let resolveFirst!: (response: Response) => void
    let resolveSecond!: (response: Response) => void
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve
    })
    const second = new Promise<Response>((resolve) => {
      resolveSecond = resolve
    })
    const fetchMock = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
    vi.stubGlobal('fetch', fetchMock)

    render(
      <MaintenanceStatusProvider>
        <StatusProbe />
      </MaintenanceStatusProvider>
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)

    visibilityState = 'hidden'
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    visibilityState = 'visible'
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('mode')).toHaveTextContent('read-only')
    expect(screen.getByTestId('write-blocked')).toHaveTextContent('true')

    await act(async () => {
      resolveSecond(new Response(
        JSON.stringify({
          mode: 'read-only',
          expectedEndAt: '2026-08-09T12:00:00.000Z',
        }),
        { status: 200 }
      ))
      await second
    })
    expect(screen.getByTestId('mode')).toHaveTextContent('read-only')
    expect(screen.getByTestId('expected-end-at')).toHaveTextContent(
      '2026-08-09T12:00:00.000Z'
    )

    await act(async () => {
      resolveFirst(new Response(
        JSON.stringify({
          mode: 'incident-read-only',
          expectedEndAt: '2026-08-09T10:00:00.000Z',
        }),
        { status: 200 }
      ))
      await first
    })
    expect(screen.getByTestId('mode')).toHaveTextContent('read-only')
    expect(screen.getByTestId('expected-end-at')).toHaveTextContent(
      '2026-08-09T12:00:00.000Z'
    )
  })

  it('アンマウント後はポーリングタイマーが止まる', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ mode: 'off' }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)

    const { unmount } = render(
      <MaintenanceStatusProvider>
        <StatusProbe />
      </MaintenanceStatusProvider>
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    unmount()

    // cleanup後のvisibility eventがlistenerを復活させたり、即時fetchを始めたり
    // しないことも確認する。
    visibilityState = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    visibilityState = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000)
    })
    // アンマウント後は追加のfetchが発生しない
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
