import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import InquiryForm from '@/components/InquiryForm'
import { MaintenanceStatusContext } from '@/components/MaintenanceStatusProvider'
import type { MaintenanceStatusResponse } from '@/lib/maintenance/client'
import jaMessages from '../../../messages/ja.json'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))

// #694 Stage 6c: 「問い合わせ」カテゴリの代表として InquiryForm
// (POST /api/support-inquiries への書き込み) を検証する。
function renderForm(status: MaintenanceStatusResponse) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MaintenanceStatusContext.Provider value={status}>
        <InquiryForm />
      </MaintenanceStatusContext.Provider>
    </NextIntlClientProvider>
  )
}

function fillForm() {
  fireEvent.change(screen.getByPlaceholderText('件名を入力（最大200文字）'), {
    target: { value: 'テスト件名' },
  })
  fireEvent.change(screen.getByPlaceholderText('お問い合わせ内容を入力（最大2000文字）'), {
    target: { value: 'テスト本文' },
  })
}

describe('InquiryForm maintenance integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mode=off のときは送信ボタンが操作可能（既存挙動を壊さない）', () => {
    renderForm({ mode: 'off' })
    fillForm()

    expect(screen.getByRole('button', { name: '送信' })).not.toBeDisabled()
    expect(screen.queryByText('メンテナンス中は操作できません')).not.toBeInTheDocument()
  })

  it('mode!=off のときは送信ボタンがdisableされ、案内文言が表示される（事前disable）', () => {
    renderForm({ mode: 'read-only' })
    fillForm()

    expect(screen.getByRole('button', { name: '送信' })).toBeDisabled()
    expect(screen.getByText('メンテナンス中は操作できません')).toBeInTheDocument()
  })

  it('incident-read-only でも同様にdisableされる', () => {
    renderForm({ mode: 'incident-read-only' })
    fillForm()

    expect(screen.getByRole('button', { name: '送信' })).toBeDisabled()
  })

  it('事前disableをすり抜けたフォーム送信（例: Enterキー）も、送信前にガードしてサーバーへfetchしない', async () => {
    const fetchMock = vi.fn(() => new Promise(() => {}))
    vi.stubGlobal('fetch', fetchMock)

    renderForm({ mode: 'read-only' })
    fillForm()

    const form = document.querySelector('form') as HTMLFormElement
    expect(form).not.toBeNull()
    fireEvent.submit(form)

    await waitFor(() => {
      expect(screen.getAllByText('メンテナンス中は操作できません').length).toBeGreaterThan(0)
    })
    expect(fetchMock).not.toHaveBeenCalled()
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

    // ポーリング間隔中に切り替わった想定: UI上はまだmode=offなので送信ボタンは押せる
    renderForm({ mode: 'off' })
    fillForm()
    fireEvent.click(screen.getByRole('button', { name: '送信' }))

    await waitFor(() => {
      expect(
        screen.getByText('ただいまメンテナンス中です。しばらくしてから再度お試しください。')
      ).toBeInTheDocument()
    })
  })
})
