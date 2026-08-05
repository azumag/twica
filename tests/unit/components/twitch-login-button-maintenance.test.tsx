import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { TwitchLoginButton } from '@/components/TwitchLoginButton'
import { logger } from '@/lib/logger'
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

  it('login APIの200応答に有効なTwitch authUrlがなければ遷移せずボタンを再度有効にする（Issue #865フォローアップ）', async () => {
    const originalHref = window.location.href
    const fetchMock = vi.fn((url: string) => {
      if (String(url).includes('/api/maintenance-status')) {
        return Promise.resolve(new Response(JSON.stringify({ mode: 'off' }), { status: 200 }))
      }
      if (String(url).includes('/api/auth/twitch/login')) {
        // origin/pathがTwitchの認可endpointと一致しない、侵害/バグ時を想定した応答
        return Promise.resolve(
          new Response(
            JSON.stringify({ authUrl: 'https://evil.example.com/phish', state: 'state-1234' }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        )
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    renderButton()

    const button = await screen.findByRole('button', { name: 'Twitchでログイン' })
    fireEvent.click(button)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Twitchでログイン' })).not.toBeDisabled()
    })
    expect(window.location.href).toBe(originalHref)
  })

  it('不正なauthUrlを拒否したときはURLをログへ渡さず固定reasonだけ記録する', async () => {
    const rejectedUrl = 'https://evil.example.com/users/alice@example.com/reset/secret?token=should-not-log'
    const fetchMock = vi.fn((url: string) => {
      if (String(url).includes('/api/maintenance-status')) {
        return Promise.resolve(new Response(JSON.stringify({ mode: 'off' }), { status: 200 }))
      }
      if (String(url).includes('/api/auth/twitch/login')) {
        return Promise.resolve(
          new Response(JSON.stringify({ authUrl: rejectedUrl, state: 'state-1234' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.mocked(logger.error).mockClear()

    renderButton()

    const button = await screen.findByRole('button', { name: 'Twitchでログイン' })
    fireEvent.click(button)

    await waitFor(() => expect(button).not.toBeDisabled())
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith('Login API returned an invalid authUrl', {
      reason: 'authorization-url-validation-failed',
    })
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain('alice@example.com')
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain('should-not-log')
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

  // #785 Fableレビュー指摘: マウント時に取得したmaintenance状態はキャッシュであり、
  // ページを開いたままメンテナンスが開始された場合には古くなる。クリック時点で
  // fetchMaintenanceStatus() を取り直して最新状態を判定していることを検証する。
  it('マウント時はmode=offでも、クリック時点でmode!=offに変わっていればログインAPIへのfetchを呼ばずボタンをdisableする', async () => {
    // マウント時のfetchMaintenanceStatus()呼び出しではoffを返し、
    // クリックによるhandleLogin内での再取得ではread-onlyを返すよう、
    // /api/maintenance-status への呼び出し回数でレスポンスを切り替える。
    let maintenanceCallCount = 0
    const fetchMock = vi.fn((url: string) => {
      if (String(url).includes('/api/maintenance-status')) {
        maintenanceCallCount += 1
        const mode = maintenanceCallCount === 1 ? 'off' : 'read-only'
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
    vi.stubGlobal('fetch', fetchMock)

    renderButton()

    // マウント時点ではmode=offなので、ボタンは操作可能な状態で表示される。
    const button = await screen.findByRole('button', { name: 'Twitchでログイン' })
    expect(button).not.toBeDisabled()

    fireEvent.click(button)

    // クリック時点の再取得でread-onlyが返るため、最終的にdisable＋案内文言に変わる。
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'メンテナンス中は操作できません' })).toBeDisabled()
    })

    // ログインAPIへのfetchは一度も発生していないこと（レースウィンドウが
    // 閉じていること）を確認する。
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).includes('/api/auth/twitch/login'))
    ).toBe(false)
  })

  // #870: ログインAPIがauthUrlもerrorも持たない応答（例: {}）を返す異常系で、
  // 従来はどちらのif/else分岐にも入らずsetIsLoading(false)が呼ばれないため、
  // disabled={isLoading || ...}でボタンが恒久的にdisableのまま取り残される。
  // フォールバック分岐でローディングを解除し、再度操作可能へ戻ることを検証する。
  it('ログインAPIがauthUrlもerrorも返さない場合でもローディングから復帰してボタンが再度操作可能になる', async () => {
    const secretValue = 'should-not-be-logged'
    const fetchMock = vi.fn((url: string) => {
      if (String(url).includes('/api/maintenance-status')) {
        return Promise.resolve(new Response(JSON.stringify({ mode: 'off' }), { status: 200 }))
      }
      if (String(url).includes('/api/auth/twitch/login')) {
        // authUrlもerrorも持たない壊れた/侵害された応答を想定し、秘密情報に
        // 見えるbodyを返す（ログへ漏れないことの検証に使う）。
        return Promise.resolve(
          new Response(JSON.stringify({ secretValue }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        )
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.mocked(logger.error).mockClear()

    renderButton()

    const button = await screen.findByRole('button', { name: 'Twitchでログイン' })
    fireEvent.click(button)

    // クリック直後は連打防止のため同期的にローディング（disable）になる。
    expect(button).toBeDisabled()

    // APIが{}（authUrlもerrorも無い）を返しても、フォールバック分岐の
    // setIsLoading(false)により最終的に再度操作可能な状態へ戻る。
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Twitchでログイン' })).not.toBeDisabled()
    })

    // 固定reasonだけをログし、応答body（秘密情報を含みうる）を漏らさない
    // （#865と同じ非漏洩ポリシー）。
    expect(logger.error).toHaveBeenCalledWith(
      'Login API returned a response with neither authUrl nor error',
      { reason: 'malformed-login-response' }
    )
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(secretValue)
  })

  // #785 Fableレビュー指摘: setIsLoading(true) を fetchMaintenanceStatus() の
  // await より前（handleLogin冒頭）に移動したことで、クリック直後・非同期処理の
  // 応答を待たずに同期的にボタンがdisableされることを直接検証する。これにより
  // クリックからボタンdisableまでのネットワークRTT分の猶予（連打で複数回
  // handleLoginが並行実行されうる時間）が無くなっていることを確認できる。
  it('クリックすると非同期処理の完了を待たずに同期的にボタンがdisableされる（連打防止）', () => {
    // 意図的に解決しないPromiseを返し、fetchMaintenanceStatus()の応答前の
    // 状態（=クリック直後の同期的な状態）を観測できるようにする。
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}))
    vi.stubGlobal('fetch', fetchMock)

    renderButton()

    // マウント時の状態取得も解決しないため、初期状態（mode=off相当）のまま
    // 同期的にレンダリングされたボタンを取得する。
    const button = screen.getByRole('button', { name: 'Twitchでログイン' })
    expect(button).not.toBeDisabled()

    fireEvent.click(button)

    // fireEvent.click は内部でactによりhandleLogin冒頭の同期的な状態更新
    // （最初のawaitに到達するまでの処理）をflushしてから返るため、
    // ここでawaitを挟まずに直後の状態を検証できる。
    expect(button).toBeDisabled()
  })
})
