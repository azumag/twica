import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import ChatDeliveryWarning from '@/components/ChatDeliveryWarning'
import { MaintenanceStatusContext } from '@/components/MaintenanceStatusProvider'
import type { MaintenanceMode } from '@/lib/maintenance/state'
import { ChatReauthorizationProvider } from '@/lib/twitch/use-chat-reauthorization'
import jaMessages from '../../../messages/ja.json'

function renderWarning(needsAttention: boolean, maintenanceMode: MaintenanceMode = 'off') {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MaintenanceStatusContext.Provider value={{ mode: maintenanceMode }}>
        <ChatReauthorizationProvider>
          <ChatDeliveryWarning needsAttention={needsAttention} />
        </ChatReauthorizationProvider>
      </MaintenanceStatusContext.Provider>
    </NextIntlClientProvider>,
  )
}

const ORIGINAL_LOCATION = window.location

function stubLocationHref() {
  const current = window.location
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      hash: current.hash,
      host: current.host,
      hostname: current.hostname,
      href: current.href,
      origin: current.origin,
      pathname: current.pathname,
      port: current.port,
      protocol: current.protocol,
      search: current.search,
    },
  })
}

describe('ChatDeliveryWarning', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    Object.defineProperty(window, 'location', { value: ORIGINAL_LOCATION, configurable: true })
  })

  it('attention=falseでは表示しない', () => {
    renderWarning(false)
    expect(screen.queryByTestId('chat-delivery-warning')).toBeNull()
  })

  it('送信不能の影響、aria-live、設定への直接導線を表示する', () => {
    renderWarning(true)
    const warning = screen.getByTestId('chat-delivery-warning')
    expect(warning).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByText('チャット通知を送信できません')).toBeInTheDocument()
    expect(screen.getByText(/送信元アカウントの再認証が必要/)).toBeInTheDocument()
    expect(screen.getByText(/ガチャとカード付与は通常どおり動作/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'チャット通知設定' })).toHaveAttribute(
      'href',
      '/dashboard/settings?section=announcement',
    )
  })

  it('再認証CTAは既存APIへuser:write:chatをPOSTする', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'temporary failure' }), {
        // reauthはDB障害でも503を返す。maintenance_* structured codeが無い
        // 503はmaintenanceへ誤分類せず、汎用の再認証失敗として表示する。
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    )
    renderWarning(true)

    fireEvent.click(screen.getByRole('button', { name: 'Twitchと再認証' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/reauth',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ additionalScopes: ['user:write:chat'] }),
      }),
    ))
    expect(screen.getByText('再認証を開始できませんでした。しばらくしてから再度お試しください。')).toBeInTheDocument()
  })

  it('同じProvider配下の別CTAを連続操作してもreauth requestは1本だけ発行する', async () => {
    let resolveResponse!: (response: Response) => void
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => new Promise<Response>((resolve) => {
        resolveResponse = resolve
      }),
    )
    render(
      <NextIntlClientProvider locale="ja" messages={jaMessages}>
        <MaintenanceStatusContext.Provider value={{ mode: 'off' }}>
          <ChatReauthorizationProvider>
            <ChatDeliveryWarning needsAttention />
            <ChatDeliveryWarning needsAttention />
          </ChatReauthorizationProvider>
        </MaintenanceStatusContext.Provider>
      </NextIntlClientProvider>,
    )

    const buttons = screen.getAllByRole('button', { name: 'Twitchと再認証' })
    fireEvent.click(buttons[0])
    // Contextの共有loadingで別consumerも即座に無効化される。handler側のrefも
    // 同じProvider instanceに属するため、state反映前の直接呼び出しにも耐える。
    expect(buttons[1]).toBeDisabled()
    fireEvent.click(buttons[1])
    expect(fetchMock).toHaveBeenCalledTimes(1)

    resolveResponse(new Response(JSON.stringify({ error: 'temporary failure' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    }))
    await waitFor(() => expect(buttons[0]).not.toBeDisabled())
  })

  it('maintenance中は再認証CTAを無効化しAPIを呼ばない', () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    renderWarning(true, 'read-only')

    const button = screen.getByRole('button', { name: 'Twitchと再認証' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'メンテナンス中は操作できません')
    fireEvent.click(button)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('network・非JSON等の未知失敗を翻訳済み文言へ正規化する', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Failed to fetch secret detail'))
    renderWarning(true)

    fireEvent.click(screen.getByRole('button', { name: 'Twitchと再認証' }))

    expect(await screen.findByText('再認証を開始できませんでした。しばらくしてから再度お試しください。')).toBeInTheDocument()
    expect(screen.queryByText(/Failed to fetch/)).toBeNull()
  })

  it('200でも非JSONならloadingを解除し、Cookie保存・redirectを行わない', async () => {
    stubLocationHref()
    const originalHref = window.location.href
    const originalCookie = document.cookie
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>not json</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }))
    renderWarning(true)

    fireEvent.click(screen.getByRole('button', { name: 'Twitchと再認証' }))

    expect(await screen.findByText('再認証を開始できませんでした。しばらくしてから再度お試しください。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Twitchと再認証' })).not.toBeDisabled()
    expect(window.location.href).toBe(originalHref)
    expect(document.cookie).toBe(originalCookie)
  })

  it('Context更新前にmaintenance 503を受けても既存翻訳へ正規化する', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: 'maintenance_read_only',
        message: 'server locale message',
        retryable: true,
      },
    }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    }))
    renderWarning(true)

    fireEvent.click(screen.getByRole('button', { name: 'Twitchと再認証' }))

    expect(await screen.findByText('メンテナンス中は操作できません')).toBeInTheDocument()
    expect(screen.queryByText('server locale message')).toBeNull()
  })

  it('成功時はOAuth state cookieを保存してTwitchへredirectする', async () => {
    stubLocationHref()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      loginUrl: `https://id.twitch.tv/oauth2/authorize?mock=1&redirect_uri=${encodeURIComponent(window.location.origin + '/api/auth/twitch/callback')}&state=state-123`,
      state: 'state-123',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    renderWarning(true)

    fireEvent.click(screen.getByRole('button', { name: 'Twitchと再認証' }))

    await waitFor(() => expect(window.location.href).toBe(
      `https://id.twitch.tv/oauth2/authorize?mock=1&redirect_uri=${encodeURIComponent(window.location.origin + '/api/auth/twitch/callback')}&state=state-123`,
    ))
    expect(document.cookie).toContain('twitch_auth_state=state-123')
  })

  it.each([
    { payload: { state: 'state-123' }, label: 'loginUrl欠落' },
    {
      payload: { loginUrl: 'https://example.com/oauth2/authorize?state=state-123', state: 'state-123' },
      label: 'Twitch外URL',
    },
    {
      payload: { loginUrl: 'https://id.twitch.tv/oauth2/authorize?state=other', state: 'state-123' },
      label: 'state不一致',
    },
  ])('200応答でも不正なOAuth payload（$label）はredirectしない', async ({ payload }) => {
    stubLocationHref()
    const originalHref = window.location.href
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    renderWarning(true)

    fireEvent.click(screen.getByRole('button', { name: 'Twitchと再認証' }))

    expect(await screen.findByText('再認証を開始できませんでした。しばらくしてから再度お試しください。')).toBeInTheDocument()
    expect(window.location.href).toBe(originalHref)
  })
})
