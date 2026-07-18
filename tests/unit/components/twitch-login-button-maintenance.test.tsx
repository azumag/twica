import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { TwitchLoginButton } from '@/components/TwitchLoginButton'
import jaMessages from '../../../messages/ja.json'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// #694 Stage 6c 既知の不具合対応（Stage 3のFableレビューで指摘）:
// TwitchLoginButton は fetch('/api/auth/twitch/login') → response.json() で
// {authUrl} を期待するが、maintenance中はこのrouteが302リダイレクトを返す
// (guardWriteRedirect)。fetch()はデフォルトでリダイレクトを追従するため、
// response.json() がリダイレクト先HTML(/?maintenance=1)のパースに失敗して
// 静かに失敗し、ボタンが無言で無反応になっていた。
//
// このコンポーネントはダッシュボード外（トップページ等）でも使われるため
// MaintenanceStatusProviderのContextは前提にできず、自身でマウント時に一度
// fetchMaintenanceStatus()（/api/maintenance-status）を呼ぶ設計にした。
function mockFetch(mode: string) {
  return vi.fn((url: string) => {
    if (String(url).includes('/api/maintenance-status')) {
      return Promise.resolve(new Response(JSON.stringify({ mode }), { status: 200 }))
    }
    if (String(url).includes('/api/auth/twitch/login')) {
      // authUrl未設定にして window.location.href への実際のナビゲーションは
      // 発生させない（テストの関心は「fetchが呼ばれたか」のみ）。
      return Promise.resolve(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    }
    return Promise.resolve(new Response('{}', { status: 200 }))
  })
}

function renderButton() {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <TwitchLoginButton />
    </NextIntlClientProvider>
  )
}

describe('TwitchLoginButton maintenance integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mode=off のときはボタンが操作可能で、クリックするとログインAPIを呼ぶ（既存挙動を壊さない）', async () => {
    const fetchMock = mockFetch('off')
    vi.stubGlobal('fetch', fetchMock)

    renderButton()

    const button = await screen.findByRole('button', { name: 'Twitchでログイン' })
    expect(button).not.toBeDisabled()

    fireEvent.click(button)

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([u]) => String(u).includes('/api/auth/twitch/login'))
      ).toBe(true)
    })
  })

  it('mode!=off のときはボタンがdisableされ案内文言を表示し、ログインAPIへのfetchを一切呼ばない', async () => {
    const fetchMock = mockFetch('read-only')
    vi.stubGlobal('fetch', fetchMock)

    renderButton()

    const button = await screen.findByRole('button', { name: 'メンテナンス中は操作できません' })
    expect(button).toBeDisabled()

    // disabled属性を持つボタンはDOM上そもそもクリックイベントを発火しないため、
    // ここでは「ログインAPIへのfetchが一度も発生していない」ことのみ確認する
    // （マウント時のmaintenance-status確認fetch以外は何も呼ばれない）。
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).includes('/api/auth/twitch/login'))
    ).toBe(false)
  })

  it('incident-read-only でも同様にボタンがdisableされる', async () => {
    vi.stubGlobal('fetch', mockFetch('incident-read-only'))

    renderButton()

    const button = await screen.findByRole('button', { name: 'メンテナンス中は操作できません' })
    expect(button).toBeDisabled()
  })
})
