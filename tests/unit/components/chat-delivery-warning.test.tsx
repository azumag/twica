import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import ChatDeliveryWarning from '@/components/ChatDeliveryWarning'
import { MaintenanceStatusContext } from '@/components/MaintenanceStatusProvider'
import type { MaintenanceMode } from '@/lib/maintenance/state'

const messages = {
  chatDeliveryWarning: {
    title: 'チャット通知を送信できません',
    description: 'Twitchの送信権限がありません。ガチャとカード付与は通常どおり動作しますが、チャット通知は送信されません。',
    reauthorize: 'Twitchと再認証',
    reauthorizing: '再認証中...',
    settingsLink: 'チャット通知設定',
    reauthFailed: '再認証を開始できませんでした。',
  },
  maintenance: {
    writeDisabled: 'メンテナンス中は変更できません',
  },
}

function renderWarning(needsAttention: boolean, maintenanceMode: MaintenanceMode = 'off') {
  return render(
    <NextIntlClientProvider locale="ja" messages={messages}>
      <MaintenanceStatusContext.Provider value={{ mode: maintenanceMode }}>
        <ChatDeliveryWarning needsAttention={needsAttention} />
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
    expect(screen.getByText('再認証を開始できませんでした。')).toBeInTheDocument()
  })

  it('maintenance中は再認証CTAを無効化しAPIを呼ばない', () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    renderWarning(true, 'read-only')

    const button = screen.getByRole('button', { name: 'Twitchと再認証' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'メンテナンス中は変更できません')
    fireEvent.click(button)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('network・非JSON等の未知失敗を翻訳済み文言へ正規化する', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Failed to fetch secret detail'))
    renderWarning(true)

    fireEvent.click(screen.getByRole('button', { name: 'Twitchと再認証' }))

    expect(await screen.findByText('再認証を開始できませんでした。')).toBeInTheDocument()
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

    expect(await screen.findByText('再認証を開始できませんでした。')).toBeInTheDocument()
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

    expect(await screen.findByText('メンテナンス中は変更できません')).toBeInTheDocument()
    expect(screen.queryByText('server locale message')).toBeNull()
  })

  it('成功時はOAuth state cookieを保存してTwitchへredirectする', async () => {
    stubLocationHref()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      loginUrl: 'https://id.twitch.tv/oauth2/authorize?mock=1&state=state-123',
      state: 'state-123',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    renderWarning(true)

    fireEvent.click(screen.getByRole('button', { name: 'Twitchと再認証' }))

    await waitFor(() => expect(window.location.href).toBe(
      'https://id.twitch.tv/oauth2/authorize?mock=1&state=state-123',
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

    expect(await screen.findByText('再認証を開始できませんでした。')).toBeInTheDocument()
    expect(window.location.href).toBe(originalHref)
  })
})
