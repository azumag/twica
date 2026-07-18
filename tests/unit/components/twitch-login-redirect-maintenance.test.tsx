import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { TwitchLoginRedirect } from '@/components/TwitchLoginRedirect'
import jaMessages from '../../../messages/ja.json'

// #694 Stage 6c 既知の不具合対応（Stage 3のFableレビューで指摘）:
// TwitchLoginRedirect はマウント時に自動で fetch('/api/auth/twitch/login') を
// 呼び、response.json() で {authUrl} を期待する。maintenance中はこのrouteが
// 302リダイレクトを返すため、response.json() がリダイレクト先HTML
// (/?maintenance=1) のパースに失敗して例外になり、「リダイレクト中...」の表示の
// まま停止して見えていた（実際には裏でcatchされた例外がconsole.errorに
// 記録されるだけで、ユーザーには何の説明もない）。
// dashboard/battle/collection の各layoutが session===null のフォールバックと
// してレンダーするため、このコンポーネントは常にMaintenanceStatusProviderの
// 外で使われる。そのため自身でマウント時にfetchMaintenanceStatus()を呼ぶ。
function mockFetch(mode: string) {
  return vi.fn((url: string) => {
    if (String(url).includes('/api/maintenance-status')) {
      return Promise.resolve(new Response(JSON.stringify({ mode }), { status: 200 }))
    }
    if (String(url).includes('/api/auth/twitch/login')) {
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

function renderRedirect() {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <TwitchLoginRedirect />
    </NextIntlClientProvider>
  )
}

describe('TwitchLoginRedirect maintenance integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mode=off のときは通常どおり「リダイレクト中」を表示し、ログインAPIを呼ぶ（既存挙動を壊さない）', async () => {
    const fetchMock = mockFetch('off')
    vi.stubGlobal('fetch', fetchMock)

    renderRedirect()

    expect(screen.getByText('Twitchログインページへ移動中...')).toBeInTheDocument()

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([u]) => String(u).includes('/api/auth/twitch/login'))
      ).toBe(true)
    })
  })

  it('mode!=off のときは「リダイレクト中」表示の代わりに案内文言を表示し、ログインAPIへのfetchを一切呼ばない', async () => {
    const fetchMock = mockFetch('read-only')
    vi.stubGlobal('fetch', fetchMock)

    renderRedirect()

    await waitFor(() => {
      expect(screen.getByText('メンテナンス中は操作できません')).toBeInTheDocument()
    })
    expect(screen.queryByText('Twitchログインページへ移動中...')).not.toBeInTheDocument()
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).includes('/api/auth/twitch/login'))
    ).toBe(false)
  })

  it('cutover-validating でも同様に案内文言を表示する', async () => {
    vi.stubGlobal('fetch', mockFetch('cutover-validating'))

    renderRedirect()

    await waitFor(() => {
      expect(screen.getByText('メンテナンス中は操作できません')).toBeInTheDocument()
    })
  })
})
