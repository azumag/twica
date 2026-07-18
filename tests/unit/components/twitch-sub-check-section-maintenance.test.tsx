import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import TwitchSubCheckSection from '@/components/TwitchSubCheckSection'
import { MaintenanceStatusContext } from '@/components/MaintenanceStatusProvider'
import type { MaintenanceStatusResponse } from '@/lib/maintenance/client'
import jaMessages from '../../../messages/ja.json'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))

// #694 Stage 6c: 「Twitchサブスク確認」カテゴリの代表として TwitchSubCheckSection
// (POST /api/auth/twitch/check-subscription, /api/auth/twitch/disable-subscription,
// POST /api/auth/reauth への書き込み) を検証する。
//
// マウント時に GET /api/auth/check-scope を呼ぶため、書き込みAPIとは別に
// 常にモックしておく必要がある。hasScope=true にすると
// 「サブスク状態を確認」ボタンが有効表示され、hasScope=false にすると
// 「権限を付与」（再認証）ボタンが表示される。
function mockFetchWithScope(hasScope: boolean, writeHandler?: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn((url: string, init?: RequestInit) => {
    if (String(url).includes('/api/auth/check-scope')) {
      return Promise.resolve(new Response(JSON.stringify({ hasScope }), { status: 200 }))
    }
    if (writeHandler) {
      return Promise.resolve(writeHandler(String(url), init))
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }))
  })
}

function renderSection(status: MaintenanceStatusResponse, initialHasSub = true) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MaintenanceStatusContext.Provider value={status}>
        <TwitchSubCheckSection initialHasSub={initialHasSub} />
      </MaintenanceStatusContext.Provider>
    </NextIntlClientProvider>
  )
}

const maintenanceErrorResponse = () =>
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

describe('TwitchSubCheckSection maintenance integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mode=off のときは確認/無効化ボタンが操作可能（既存挙動を壊さない）', async () => {
    vi.stubGlobal('fetch', mockFetchWithScope(true))
    renderSection({ mode: 'off' }, true)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'サブスク状態を確認' })).not.toBeDisabled()
    })
    expect(screen.getByRole('button', { name: 'サブスクを無効化' })).not.toBeDisabled()
    expect(screen.queryByText('メンテナンス中は操作できません')).not.toBeInTheDocument()
  })

  it('mode!=off のときは確認/無効化ボタンがdisableされ、案内文言が表示される（事前disable）', async () => {
    vi.stubGlobal('fetch', mockFetchWithScope(true))
    renderSection({ mode: 'read-only' }, true)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'サブスク状態を確認' })).toBeDisabled()
    })
    expect(screen.getByRole('button', { name: 'サブスクを無効化' })).toBeDisabled()
    expect(screen.getByText('メンテナンス中は操作できません')).toBeInTheDocument()
  })

  it('mode!=off のときは再認証ボタン（権限を付与）もdisableされる', async () => {
    vi.stubGlobal('fetch', mockFetchWithScope(false))
    renderSection({ mode: 'read-only' }, false)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '権限を付与' })).toBeDisabled()
    })
  })

  it('事前disableをすり抜けてサブスク確認がmaintenance 503で拒否された場合、サーバーの案内文言を表示する', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchWithScope(true, (url) => {
        if (url.includes('/api/auth/twitch/check-subscription')) {
          return maintenanceErrorResponse()
        }
        return new Response(JSON.stringify({}), { status: 200 })
      })
    )
    renderSection({ mode: 'off' }, true)

    const checkButton = await screen.findByRole('button', { name: 'サブスク状態を確認' })
    fireEvent.click(checkButton)

    await waitFor(() => {
      expect(
        screen.getByText('ただいまメンテナンス中です。しばらくしてから再度お試しください。')
      ).toBeInTheDocument()
    })
  })

  it('事前disableをすり抜けてサブスク無効化がmaintenance 503で拒否された場合、サーバーの案内文言を表示する', async () => {
    const confirmMock = vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.stubGlobal(
      'fetch',
      mockFetchWithScope(true, (url) => {
        if (url.includes('/api/auth/twitch/disable-subscription')) {
          return maintenanceErrorResponse()
        }
        return new Response(JSON.stringify({}), { status: 200 })
      })
    )
    renderSection({ mode: 'off' }, true)

    const disableButton = await screen.findByRole('button', { name: 'サブスクを無効化' })
    fireEvent.click(disableButton)

    await waitFor(() => {
      expect(
        screen.getByText('ただいまメンテナンス中です。しばらくしてから再度お試しください。')
      ).toBeInTheDocument()
    })
    confirmMock.mockRestore()
  })
})
