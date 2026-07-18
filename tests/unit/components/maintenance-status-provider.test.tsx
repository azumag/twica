import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
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
    </div>
  )
}

describe('MaintenanceStatusProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('Provider の外で useMaintenanceStatus() を呼ぶと安全側のoffを返す（例外にしない）', () => {
    render(<StatusProbe />)
    expect(screen.getByTestId('mode')).toHaveTextContent('off')
  })

  it('マウント時に即座に1回fetchし、取得したstatusをcontext経由で配る', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ mode: 'read-only', expectedEndAt: '2026-07-20T00:00:00.000Z' }),
        { status: 200 }
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    render(
      <MaintenanceStatusProvider>
        <StatusProbe />
      </MaintenanceStatusProvider>
    )

    await waitFor(() => {
      expect(screen.getByTestId('mode')).toHaveTextContent('read-only')
    })
    expect(screen.getByTestId('expected-end-at')).toHaveTextContent('2026-07-20T00:00:00.000Z')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/maintenance-status',
      expect.objectContaining({ cache: 'no-store' })
    )
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

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000)
    })
    // アンマウント後は追加のfetchが発生しない
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
