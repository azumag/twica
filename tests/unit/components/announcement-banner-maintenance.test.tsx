import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import AnnouncementBanner from '@/components/AnnouncementBanner'
import { MaintenanceStatusContext } from '@/components/MaintenanceStatusProvider'
import type { MaintenanceStatusResponse } from '@/lib/maintenance/client'
import jaMessages from '../../../messages/ja.json'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))

// #694 Stage 6c: AnnouncementBanner の既読ボタン（POST /api/announcements/read）
// に対するmaintenance統合テスト。CardVisibilitySettings等と同じパターンを踏襲する。

function renderBanner(status: MaintenanceStatusResponse) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MaintenanceStatusContext.Provider value={status}>
        <AnnouncementBanner
          announcements={[
            { id: 'ann-1', title: 'お知らせ', body: '本文', severity: 'info' },
          ]}
        />
      </MaintenanceStatusContext.Provider>
    </NextIntlClientProvider>
  )
}

describe('AnnouncementBanner maintenance integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mode=off のときは既読ボタンが操作可能（既存挙動を壊さない）', () => {
    renderBanner({ mode: 'off' })
    const button = screen.getByRole('button', { name: /既読にする/ })
    expect(button).not.toBeDisabled()
  })

  it('mode!=off のときは既読ボタンがdisableされ、tooltipで理由が表示される（事前disable）', () => {
    renderBanner({ mode: 'read-only' })
    const button = screen.getByRole('button', { name: /既読にする/ })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'メンテナンス中は操作できません')
  })

  it('incident-read-only でも同様にdisableされる', () => {
    renderBanner({ mode: 'incident-read-only' })
    expect(screen.getByRole('button', { name: /既読にする/ })).toBeDisabled()
  })

  it('事前disableをすり抜けて書き込みが503(maintenance)で拒否された場合、サーバーの案内文言を表示する', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'maintenance_read_only',
            message: 'ただいまメンテナンス中です。しばらくしてから再度お試しください。',
            retryable: true,
          },
        }),
        { status: 503 }
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    // ポーリング間隔中に切り替わった想定: UI上はまだmode=offなのでボタンは押せる
    renderBanner({ mode: 'off' })
    fireEvent.click(screen.getByRole('button', { name: /既読にする/ }))

    await waitFor(() => {
      expect(
        screen.getByText('ただいまメンテナンス中です。しばらくしてから再度お試しください。')
      ).toBeInTheDocument()
    })
  })
})
