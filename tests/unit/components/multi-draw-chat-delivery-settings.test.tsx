import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatAnnouncementSettings from '@/components/ChatAnnouncementSettings'
import { ChatReauthorizationProvider } from '@/lib/twitch/use-chat-reauthorization'
import jaMessages from '../../../messages/ja.json'
import multiDrawMessages from '../../../messages/features/multi-draw-chat/ja.json'

const routerMocks = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => routerMocks,
}))

function renderSettings() {
  return render(
    <NextIntlClientProvider
      locale="ja"
      messages={{ ...jaMessages, ...multiDrawMessages }}
    >
      <ChatReauthorizationProvider>
        <ChatAnnouncementSettings
          streamerId="streamer-1"
          currentEnabled={false}
          currentTemplate={null}
          currentMultiTemplate={null}
          currentMultiShowCards
          botAccount={null}
        />
      </ChatReauthorizationProvider>
    </NextIntlClientProvider>,
  )
}

describe('multi-draw chat delivery settings alias integration (#1561)', () => {
  const deliveryPut = vi.fn()

  beforeEach(() => {
    routerMocks.refresh.mockReset()
    deliveryPut.mockReset()

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()

        if (url.includes('/api/auth/check-scope')) {
          return new Response(JSON.stringify({ hasScope: true }), { status: 200 })
        }

        if (url.includes('/api/streamer/chat-multi-delivery')) {
          if ((init?.method ?? 'GET') === 'PUT') {
            deliveryPut(init?.body)
            return new Response(JSON.stringify({ success: true }), { status: 200 })
          }

          return new Response(
            JSON.stringify({
              deliveryMode: 'summary',
              chunkSize: 3,
              intervalMs: 1600,
            }),
            { status: 200 },
          )
        }

        throw new Error(`Unexpected fetch: ${url}`)
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('production alias経由でN連配送UIを開き、chunked設定を保存できる', async () => {
    renderSettings()

    fireEvent.click(await screen.findByRole('button', { name: 'N連通知方式を設定' }))

    expect(await screen.findByRole('heading', { name: 'N連通知方式' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /1投稿にまとめる/ })).toBeChecked()

    fireEvent.click(screen.getByRole('radio', { name: /数枚ずつ送る/ }))
    const chunkSize = screen.getByRole('combobox', { name: '1投稿あたりの枚数' })
    expect(chunkSize).toHaveValue('3')
    fireEvent.change(chunkSize, { target: { value: '5' } })

    expect(
      screen.getByText(/Twitchの連投制限に余裕を持たせるため/),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '通知方式を保存' }))

    await waitFor(() => expect(deliveryPut).toHaveBeenCalledTimes(1))
    expect(JSON.parse(String(deliveryPut.mock.calls[0]?.[0]))).toEqual({
      deliveryMode: 'chunked',
      chunkSize: 5,
    })
    expect(await screen.findByText('N連通知方式を保存しました。')).toBeInTheDocument()
  })
})
