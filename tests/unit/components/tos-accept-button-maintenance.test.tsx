import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import TosAcceptButton from '@/components/TosAcceptButton'
import { MaintenanceStatusContext } from '@/components/MaintenanceStatusProvider'
import type { MaintenanceStatusResponse } from '@/lib/maintenance/client'
import jaMessages from '../../../messages/ja.json'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

// #694 Stage 6c: 「利用規約同意」カテゴリの代表として TosAcceptButton
// (POST /api/tos/accept への書き込み) を検証する。
//
// 実運用上の注意: TosAcceptButton は /tos ページ（dashboard/layout.tsx の外）で
// 使われるため、本番では MaintenanceStatusProvider は設置されていない。
// 以下の「事前disable」系テストは MaintenanceStatusContext.Provider を直接注入して
// コンポーネント自体のロジックを検証するものであり、本番の実配線を示すものではない
// （最後の「Provider無し」テストが実際の本番配線を再現する）。
function renderButton(status: MaintenanceStatusResponse) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MaintenanceStatusContext.Provider value={status}>
        <TosAcceptButton isLoggedIn hasAccepted={false} />
      </MaintenanceStatusContext.Provider>
    </NextIntlClientProvider>
  )
}

const BUTTON_NAME = '利用規約に同意してサービスを利用する'

describe('TosAcceptButton maintenance integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mode=off のときは同意ボタンが操作可能（既存挙動を壊さない）', () => {
    renderButton({ mode: 'off' })

    expect(screen.getByRole('button', { name: BUTTON_NAME })).not.toBeDisabled()
    expect(screen.queryByText('メンテナンス中は操作できません')).not.toBeInTheDocument()
  })

  it('mode!=off のときは同意ボタンがdisableされ、案内文言が表示される（事前disable、Provider経由）', () => {
    renderButton({ mode: 'read-only' })

    expect(screen.getByRole('button', { name: BUTTON_NAME })).toBeDisabled()
    expect(screen.getByText('メンテナンス中は操作できません')).toBeInTheDocument()
  })

  it('本番配線（MaintenanceStatusProvider無し）でも、書き込みが503(maintenance)で拒否された場合はサーバーの案内文言を表示する', async () => {
    // /tosページの実際のツリーを再現: Context.Providerを一切かぶせず、
    // useMaintenanceStatus()のデフォルト値(mode:'off')のまま動作することを検証する。
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

    render(
      <NextIntlClientProvider locale="ja" messages={jaMessages}>
        <TosAcceptButton isLoggedIn hasAccepted={false} />
      </NextIntlClientProvider>
    )

    const button = screen.getByRole('button', { name: BUTTON_NAME })
    expect(button).not.toBeDisabled()
    fireEvent.click(button)

    await waitFor(() => {
      expect(
        screen.getByText('ただいまメンテナンス中です。しばらくしてから再度お試しください。')
      ).toBeInTheDocument()
    })
  })
})
