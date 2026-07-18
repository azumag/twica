import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import VoteCampaignButton from '@/components/VoteCampaignButton'
import { MaintenanceStatusContext } from '@/components/MaintenanceStatusProvider'
import type { MaintenanceStatusResponse } from '@/lib/maintenance/client'
import jaMessages from '../../../messages/ja.json'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))

const BUTTON_NAME = '選挙行ったよ/行こうかな'

// #694 Stage 6c: 「ストレージボーナス投票キャンペーン」カテゴリの代表として
// VoteCampaignButton (POST /api/storage-bonus/vote-campaign への書き込み) を検証する。
// このコンポーネントは next-intl の maintenance 名前空間のみ利用するよう追加した
// （他のUIテキストは既存どおりハードコードされた日本語のまま）。
function renderButton(status: MaintenanceStatusResponse) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MaintenanceStatusContext.Provider value={status}>
        <VoteCampaignButton visible bonusMb={5} />
      </MaintenanceStatusContext.Provider>
    </NextIntlClientProvider>
  )
}

describe('VoteCampaignButton maintenance integration', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mode=off のときはボタンが操作可能（既存挙動を壊さない）', () => {
    renderButton({ mode: 'off' })

    expect(screen.getByRole('button', { name: BUTTON_NAME })).not.toBeDisabled()
    expect(screen.queryByText('メンテナンス中は操作できません')).not.toBeInTheDocument()
  })

  it('mode!=off のときはボタンがdisableされ、案内文言が表示される（事前disable）', () => {
    renderButton({ mode: 'read-only' })

    expect(screen.getByRole('button', { name: BUTTON_NAME })).toBeDisabled()
    expect(screen.getByText('メンテナンス中は操作できません')).toBeInTheDocument()
  })

  it('incident-read-only でも同様にdisableされる', () => {
    renderButton({ mode: 'incident-read-only' })

    expect(screen.getByRole('button', { name: BUTTON_NAME })).toBeDisabled()
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

    renderButton({ mode: 'off' })
    fireEvent.click(screen.getByRole('button', { name: BUTTON_NAME }))

    await waitFor(() => {
      expect(
        screen.getByText('ただいまメンテナンス中です。しばらくしてから再度お試しください。')
      ).toBeInTheDocument()
    })
  })
})
