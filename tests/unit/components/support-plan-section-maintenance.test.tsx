import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import SupportPlanSection from '@/components/SupportPlanSection'
import { MaintenanceStatusContext } from '@/components/MaintenanceStatusProvider'
import type { MaintenanceStatusResponse } from '@/lib/maintenance/client'
import type { PlanType } from '@/lib/plan-constants'
import jaMessages from '../../../messages/ja.json'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))

// #694 Stage 6c: 「支援プラン」カテゴリの代表として SupportPlanSection
// (/api/support/activate, /api/support/deactivate への書き込み) を検証する。
function renderSection(currentPlan: PlanType, status: MaintenanceStatusResponse) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MaintenanceStatusContext.Provider value={status}>
        <SupportPlanSection currentPlan={currentPlan} />
      </MaintenanceStatusContext.Provider>
    </NextIntlClientProvider>
  )
}

function fillCode() {
  fireEvent.change(screen.getByPlaceholderText('コードを入力してください'), {
    target: { value: 'CODE123' },
  })
}

describe('SupportPlanSection maintenance integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mode=off のときは有効化ボタンが操作可能（既存挙動を壊さない）', () => {
    renderSection('basic', { mode: 'off' })
    fillCode()

    expect(screen.getByRole('button', { name: '有効化' })).not.toBeDisabled()
    expect(screen.queryByText('メンテナンス中は操作できません')).not.toBeInTheDocument()
  })

  it('mode!=off のときは有効化ボタンがdisableされ、案内文言が表示される（事前disable）', () => {
    renderSection('basic', { mode: 'read-only' })
    fillCode()

    expect(screen.getByRole('button', { name: '有効化' })).toBeDisabled()
    expect(screen.getByText('メンテナンス中は操作できません')).toBeInTheDocument()
  })

  it('mode!=off のときは素地に戻すボタンもdisableされる', () => {
    renderSection('support', { mode: 'read-only' })

    expect(screen.getByRole('button', { name: '素地に戻す' })).toBeDisabled()
  })

  it('事前disableをすり抜けたフォーム送信（例: Enterキー）も、送信前にガードしてサーバーへfetchしない', async () => {
    const fetchMock = vi.fn(() => new Promise(() => {}))
    vi.stubGlobal('fetch', fetchMock)

    renderSection('basic', { mode: 'read-only' })
    fillCode()

    const form = document.querySelector('form') as HTMLFormElement
    expect(form).not.toBeNull()
    fireEvent.submit(form)

    await waitFor(() => {
      expect(screen.getAllByText('メンテナンス中は操作できません').length).toBeGreaterThan(0)
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('事前disableをすり抜けて有効化が503(maintenance)で拒否された場合、サーバーの案内文言を表示する', async () => {
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

    renderSection('basic', { mode: 'off' })
    fillCode()
    fireEvent.click(screen.getByRole('button', { name: '有効化' }))

    await waitFor(() => {
      expect(
        screen.getByText('ただいまメンテナンス中です。しばらくしてから再度お試しください。')
      ).toBeInTheDocument()
    })
  })
})
