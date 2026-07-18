import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import InquiryThread from '@/components/InquiryThread'
import { MaintenanceStatusContext } from '@/components/MaintenanceStatusProvider'
import type { MaintenanceStatusResponse } from '@/lib/maintenance/client'
import jaMessages from '../../../messages/ja.json'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))

// #694 Stage 6c: 「問い合わせ」カテゴリの返信フォームとして InquiryThread
// (POST /api/support-inquiries/[id]/messages への書き込み) を検証する。
function renderThread(status: MaintenanceStatusResponse) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MaintenanceStatusContext.Provider value={status}>
        <InquiryThread
          inquiryId="inquiry-1"
          status="open"
          initialBody="最初の質問です"
          createdAt="2026-07-01T00:00:00Z"
          messages={[]}
        />
      </MaintenanceStatusContext.Provider>
    </NextIntlClientProvider>
  )
}

function fillReply() {
  fireEvent.change(screen.getByLabelText('返信'), { target: { value: '返信テスト' } })
}

describe('InquiryThread maintenance integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mode=off のときは返信ボタンが操作可能（既存挙動を壊さない）', () => {
    renderThread({ mode: 'off' })
    fillReply()

    expect(screen.getByRole('button', { name: '返信' })).not.toBeDisabled()
    expect(screen.queryByText('メンテナンス中は操作できません')).not.toBeInTheDocument()
  })

  it('mode!=off のときは返信ボタンがdisableされ、案内文言が表示される（事前disable）', () => {
    renderThread({ mode: 'read-only' })
    fillReply()

    expect(screen.getByRole('button', { name: '返信' })).toBeDisabled()
    expect(screen.getByText('メンテナンス中は操作できません')).toBeInTheDocument()
  })

  it('cutover-validating でも同様にdisableされる', () => {
    renderThread({ mode: 'cutover-validating' })
    fillReply()

    expect(screen.getByRole('button', { name: '返信' })).toBeDisabled()
  })

  it('事前disableをすり抜けたフォーム送信（例: Enterキー）も、送信前にガードしてサーバーへfetchしない', async () => {
    const fetchMock = vi.fn(() => new Promise(() => {}))
    vi.stubGlobal('fetch', fetchMock)

    renderThread({ mode: 'read-only' })
    fillReply()

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

    renderThread({ mode: 'off' })
    fillReply()
    fireEvent.click(screen.getByRole('button', { name: '返信' }))

    await waitFor(() => {
      expect(
        screen.getByText('ただいまメンテナンス中です。しばらくしてから再度お試しください。')
      ).toBeInTheDocument()
    })
  })

  it('closedステータスのときはフォーム自体が表示されない（既存挙動）', () => {
    render(
      <NextIntlClientProvider locale="ja" messages={jaMessages}>
        <MaintenanceStatusContext.Provider value={{ mode: 'read-only' }}>
          <InquiryThread
            inquiryId="inquiry-1"
            status="closed"
            initialBody="最初の質問です"
            createdAt="2026-07-01T00:00:00Z"
            messages={[]}
          />
        </MaintenanceStatusContext.Provider>
      </NextIntlClientProvider>
    )

    expect(document.querySelector('form')).toBeNull()
    expect(screen.queryByText('メンテナンス中は操作できません')).not.toBeInTheDocument()
  })
})
