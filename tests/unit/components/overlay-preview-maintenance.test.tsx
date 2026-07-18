import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import OverlayPreview from '@/components/OverlayPreview'
import { MaintenanceStatusContext } from '@/components/MaintenanceStatusProvider'
import type { MaintenanceStatusResponse } from '@/lib/maintenance/client'
import jaMessages from '../../../messages/ja.json'

// #694 Stage 6c: 「オーバーレイプレビュー」カテゴリの代表として OverlayPreview の
// 実際の書き込みボタン（POST /api/gacha「実際に引く」、POST /api/gacha/demo「OBS DEMO」）
// を検証する。
//
// 注記: 対象ファイル一覧の説明には「POST/DELETE /api/streamer/additional-rewards」も
// 記載されていたが、実装を確認したところ OverlayPreview.tsx はこのrouteを一切
// 呼んでいない（該当するのはChannelPointSettings.tsx側で、別バッチ担当ファイル）。
// 代わりに実際にこのファイルが呼んでいる書き込みroute（/api/gacha, /api/gacha/demo）
// をここで検証する。

function createLocalStorageMock() {
  const store = new Map<string, string>()
  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value)
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key)
    }),
    clear: vi.fn(() => {
      store.clear()
    }),
  }
}

function renderPreview(status: MaintenanceStatusResponse) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MaintenanceStatusContext.Provider value={status}>
        <OverlayPreview streamerId="streamer-1" baseUrl="https://example.com" />
      </MaintenanceStatusContext.Provider>
    </NextIntlClientProvider>
  )
}

describe('OverlayPreview maintenance integration (OBS DEMO)', () => {
  beforeEach(() => {
    const localStorageMock = createLocalStorageMock()
    Object.defineProperty(window, 'localStorage', {
      value: localStorageMock,
      configurable: true,
    })
    vi.stubGlobal('localStorage', localStorageMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mode=off のときはOBS DEMOボタンが操作可能（既存挙動を壊さない）', () => {
    renderPreview({ mode: 'off' })
    expect(screen.getByRole('button', { name: 'OBS DEMO' })).not.toBeDisabled()
  })

  it('mode!=off のときはOBS DEMOボタンがdisableされ、案内文言がtitleに設定される（事前disable）', () => {
    renderPreview({ mode: 'read-only' })
    const button = screen.getByRole('button', { name: 'OBS DEMO' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'メンテナンス中は操作できません')
  })

  it('事前disableをすり抜けてOBS DEMOがmaintenance 503で拒否された場合、alertでサーバーの案内文言を表示する', async () => {
    const alertMock = vi.spyOn(window, 'alert').mockImplementation(() => {})
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

    renderPreview({ mode: 'off' })
    fireEvent.click(screen.getByRole('button', { name: 'OBS DEMO' }))

    await waitFor(() => {
      expect(alertMock).toHaveBeenCalledWith(
        'ただいまメンテナンス中です。しばらくしてから再度お試しください。'
      )
    })
    alertMock.mockRestore()
  })
})

// 「実際に引く」ボタンは isPreviewAppUrl(NEXT_PUBLIC_APP_URL) が true の場合のみ
// 描画される。この判定はモジュールトップレベルの定数として一度だけ評価される
// (OverlayPreview.tsx の isPreviewEnvironment 参照) ため、通常の静的importでは
// tests/setup.tsが設定する非preview環境のまま固定されてしまう。
// vi.resetModules() でモジュールキャッシュを破棄し、環境変数を設定してから
// 動的importし直すことでpreview環境を再現する。MaintenanceStatusContextも
// 同じ動的importから取得しないと、OverlayPreview側が参照するContextと
// 別インスタンスになりProviderの値が反映されない点に注意。
describe('OverlayPreview maintenance integration (実際に引く, preview環境)', () => {
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL

  beforeEach(() => {
    const localStorageMock = createLocalStorageMock()
    Object.defineProperty(window, 'localStorage', {
      value: localStorageMock,
      configurable: true,
    })
    vi.stubGlobal('localStorage', localStorageMock)
    vi.resetModules()
    process.env.NEXT_PUBLIC_APP_URL = 'https://twica-preview.example.workers.dev'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    process.env.NEXT_PUBLIC_APP_URL = originalAppUrl
    vi.resetModules()
  })

  async function renderPreviewEnv(status: MaintenanceStatusResponse) {
    const { default: FreshOverlayPreview } = await import('@/components/OverlayPreview')
    const { MaintenanceStatusContext: FreshContext } = await import(
      '@/components/MaintenanceStatusProvider'
    )
    return render(
      <NextIntlClientProvider locale="ja" messages={jaMessages}>
        <FreshContext.Provider value={status}>
          <FreshOverlayPreview streamerId="streamer-1" baseUrl="https://example.com" />
        </FreshContext.Provider>
      </NextIntlClientProvider>
    )
  }

  it('mode=off のときは「実際に引く」ボタンが操作可能（既存挙動を壊さない）', async () => {
    await renderPreviewEnv({ mode: 'off' })
    expect(screen.getByRole('button', { name: '実際に引く' })).not.toBeDisabled()
  })

  it('mode!=off のときは「実際に引く」ボタンがdisableされる（事前disable）', async () => {
    await renderPreviewEnv({ mode: 'read-only' })
    const button = screen.getByRole('button', { name: '実際に引く' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'メンテナンス中は操作できません')
  })

})
