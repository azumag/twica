import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import CardVisibilitySettings from '@/components/CardVisibilitySettings'
import { MaintenanceStatusContext } from '@/components/MaintenanceStatusProvider'
import type { MaintenanceStatusResponse } from '@/lib/maintenance/client'
import jaMessages from '../../../messages/ja.json'

vi.mock('@/lib/logger')

// #694 Stage 6b: 「設定保存」カテゴリの代表として CardVisibilitySettings
// (/api/streamer/settings への書き込み) を検証する。
function renderSettings(status: MaintenanceStatusResponse) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MaintenanceStatusContext.Provider value={status}>
        <CardVisibilitySettings
          streamerId="streamer-1"
          currentShowUnowned={false}
          currentShowUnownedDetails={false}
        />
      </MaintenanceStatusContext.Provider>
    </NextIntlClientProvider>
  )
}

// #1093: DOM順ではなく可視ラベル由来のアクセシブルネームで取得し、
// label/htmlFor の関連付けが壊れた場合も既存maintenanceテストで回帰検知する。
function getToggles() {
  return [
    screen.getByRole('checkbox', { name: '未所持カードを表示' }),
    screen.getByRole('checkbox', { name: '未所持カードの詳細を公開' }),
  ] as const
}

describe('CardVisibilitySettings maintenance integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mode=off のときはトグルが操作可能（既存挙動を壊さない）', () => {
    renderSettings({ mode: 'off' })
    const [showUnownedToggle] = getToggles()
    expect(showUnownedToggle).not.toBeDisabled()
    expect(screen.queryByText('メンテナンス中は操作できません')).not.toBeInTheDocument()
  })

  it('mode!=off のときはトグルがdisableされ、案内文言が表示される（事前disable）', () => {
    renderSettings({ mode: 'read-only' })
    const [showUnownedToggle] = getToggles()
    expect(showUnownedToggle).toBeDisabled()
    expect(screen.getByText('メンテナンス中は操作できません')).toBeInTheDocument()
  })

  it('incident-read-only でも同様にdisableされる', () => {
    renderSettings({ mode: 'incident-read-only' })
    const [showUnownedToggle] = getToggles()
    expect(showUnownedToggle).toBeDisabled()
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

    // ポーリング間隔中に切り替わった想定: UI上はまだmode=offなのでトグルは押せる
    renderSettings({ mode: 'off' })
    const [showUnownedToggle] = getToggles()
    fireEvent.click(showUnownedToggle)

    await waitFor(() => {
      expect(
        screen.getByText('ただいまメンテナンス中です。しばらくしてから再度お試しください。')
      ).toBeInTheDocument()
    })
    // 楽観的更新は失敗時にロールバックされる
    expect(showUnownedToggle).not.toBeChecked()
  })

  it('mode!=off でもshowDetailsトグルは元々のshowUnowned依存disableと重複してdisableされる', () => {
    renderSettings({ mode: 'read-only' })
    const [, showDetailsToggle] = getToggles()
    expect(showDetailsToggle).toBeDisabled()
  })
})
