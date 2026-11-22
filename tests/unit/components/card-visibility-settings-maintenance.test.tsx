import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import CardVisibilitySettings from '@/components/CardVisibilitySettings'
import { MaintenanceStatusContext } from '@/components/MaintenanceStatusProvider'
import type { MaintenanceStatusResponse } from '@/lib/maintenance/client'
import jaMessages from '../../../messages/ja.json'

vi.mock('@/lib/logger')

// #694 Stage 6b: 「設定保存」カテゴリの代表として CardVisibilitySettings
// (/api/streamer/settings への書き込み) を検証する。
// #2070 フォローアップ (C4b): 詳細公開の一括トグルは廃止し、名前・画像・説明の
// 3チェックボックスになった。props も3項目の初期値を受け取る。
function renderSettings(
  status: MaintenanceStatusResponse,
  currentShowUnowned = false,
  items: { name?: boolean; image?: boolean; description?: boolean } = {}
) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MaintenanceStatusContext.Provider value={status}>
        <CardVisibilitySettings
          streamerId="streamer-1"
          currentShowUnowned={currentShowUnowned}
          currentShowUnownedName={items.name ?? false}
          currentShowUnownedImage={items.image ?? false}
          currentShowUnownedDescription={items.description ?? false}
        />
      </MaintenanceStatusContext.Provider>
    </NextIntlClientProvider>
  )
}

// #1093: DOM順ではなく可視ラベル由来のアクセシブルネームで取得し、
// label/htmlFor の関連付けが壊れた場合も既存maintenanceテストで回帰検知する。
function getToggles() {
  return [
    screen.getByRole('checkbox', {
      name: jaMessages.cardVisibilitySettings.form.showUnowned,
    }),
    screen.getByRole('checkbox', {
      name: jaMessages.cardVisibilitySettings.form.showName,
    }),
    screen.getByRole('checkbox', {
      name: jaMessages.cardVisibilitySettings.form.showImage,
    }),
    screen.getByRole('checkbox', {
      name: jaMessages.cardVisibilitySettings.form.showDescription,
    }),
  ] as const
}

describe('CardVisibilitySettings accessible descriptions', () => {
  it('コレクション公開設定の見出しを表示する', () => {
    renderSettings({ mode: 'off' })

    expect(
      screen.getByRole('heading', { name: jaMessages.cardVisibilitySettings.title })
    ).toBeInTheDocument()
  })

  it('未所持カード表示トグルを補足説明へ関連付ける', () => {
    renderSettings({ mode: 'off' })
    const [showUnownedToggle] = getToggles()

    expect(showUnownedToggle).toHaveAccessibleDescription(
      jaMessages.cardVisibilitySettings.form.showUnownedHelp
    )
  })

  it('項目別チェックボックスは未所持カード非表示時だけ前提条件も説明する', () => {
    const { unmount } = renderSettings({ mode: 'off' })
    const [, hiddenNameToggle] = getToggles()

    expect(hiddenNameToggle).toHaveAccessibleDescription(
      `${jaMessages.cardVisibilitySettings.form.showNameHelp} ${jaMessages.cardVisibilitySettings.form.requiresShowUnowned}`
    )

    unmount()
    renderSettings({ mode: 'off' }, true)
    const [, visibleNameToggle] = getToggles()

    expect(visibleNameToggle).toHaveAccessibleDescription(
      jaMessages.cardVisibilitySettings.form.showNameHelp
    )
  })

  it('名前・画像・説明の3チェックボックスを初期値どおりに表示する', () => {
    renderSettings({ mode: 'off' }, true, { name: true, image: false, description: true })
    const [, nameToggle, imageToggle, descriptionToggle] = getToggles()

    expect(nameToggle).toBeChecked()
    expect(imageToggle).not.toBeChecked()
    expect(descriptionToggle).toBeChecked()
  })

  it('未所持カードを表示しないときは3項目ともdisabledにする', () => {
    renderSettings({ mode: 'off' }, false)
    const [, nameToggle, imageToggle, descriptionToggle] = getToggles()

    expect(nameToggle).toBeDisabled()
    expect(imageToggle).toBeDisabled()
    expect(descriptionToggle).toBeDisabled()
    // 依存が満たされない理由を画面にも出す。
    expect(
      screen.getByText(jaMessages.cardVisibilitySettings.form.requiresShowUnowned)
    ).toBeInTheDocument()
  })

  it('説明はトレード・オークションに出ないことと、#Nで取引できることを注記する', () => {
    renderSettings({ mode: 'off' }, true)

    expect(
      screen.getByText(jaMessages.cardVisibilitySettings.form.descriptionTradeNote)
    ).toBeInTheDocument()
    expect(
      screen.getByText(jaMessages.cardVisibilitySettings.form.tradeNumberNote)
    ).toBeInTheDocument()
  })

  it('表示をOFFにする操作で3項目もfalseにして同じリクエストで保存する', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)
    renderSettings({ mode: 'off' }, true, { name: true, image: true, description: true })

    const [showUnownedToggle, nameToggle, imageToggle, descriptionToggle] = getToggles()
    fireEvent.click(showUnownedToggle)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/streamer/settings',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            streamerId: 'streamer-1',
            showUnownedCards: false,
            showUnownedCardName: false,
            showUnownedCardImage: false,
            showUnownedCardDescription: false,
          }),
        })
      )
    })

    // 楽観反映として3項目も即座にOFFになり、DBにtrueが残らない。
    await waitFor(() => {
      expect(nameToggle).not.toBeChecked()
      expect(imageToggle).not.toBeChecked()
      expect(descriptionToggle).not.toBeChecked()
    })
  })

  it('項目別チェックボックスは変更した1項目だけをAPIへ送る', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)
    renderSettings({ mode: 'off' }, true)

    const [, nameToggle] = getToggles()
    fireEvent.click(nameToggle)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/streamer/settings',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            streamerId: 'streamer-1',
            showUnownedCardName: true,
          }),
        })
      )
    })
    expect(nameToggle).toBeChecked()
  })

  it('項目別公開の保存がデプロイ窓でskipされたら楽観反映を戻す', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ success: true, unownedCardItemSettingsSkippedDeployWindow: true }),
          { status: 200 }
        )
      )
    )
    renderSettings({ mode: 'off' }, true)

    const [, nameToggle] = getToggles()
    fireEvent.click(nameToggle)
    expect(nameToggle).toBeChecked()

    await waitFor(() => {
      expect(nameToggle).not.toBeChecked()
    })
    expect(
      screen.getByText(jaMessages.cardVisibilitySettings.errors.deployWindow)
    ).toBeInTheDocument()
  })
})

describe('CardVisibilitySettings maintenance integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mode=off のときはトグルが操作可能（既存挙動を壊さない）', () => {
    renderSettings({ mode: 'off' })
    const [showUnownedToggle] = getToggles()
    expect(showUnownedToggle).not.toBeDisabled()
    expect(screen.queryByText(jaMessages.maintenance.writeDisabled)).not.toBeInTheDocument()
  })

  it('mode!=off のときはトグルがdisableされ、案内文言が表示される（事前disable）', () => {
    renderSettings({ mode: 'read-only' })
    const [showUnownedToggle] = getToggles()
    expect(showUnownedToggle).toBeDisabled()
    expect(screen.getByText(jaMessages.maintenance.writeDisabled)).toBeInTheDocument()
  })

  it('incident-read-only でも同様にdisableされる', () => {
    renderSettings({ mode: 'incident-read-only' })
    const [showUnownedToggle] = getToggles()
    expect(showUnownedToggle).toBeDisabled()
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

    // ポーリング間隔中に切り替わった想定: UI上はまだmode=offなのでトグルは押せる
    renderSettings({ mode: 'off' })
    const [showUnownedToggle] = getToggles()
    fireEvent.click(showUnownedToggle)

    await waitFor(() => {
      expect(
        screen.getByText('ただいまメンテナンス中です。しばらくしてから再度お試しください。')
      ).toBeInTheDocument()
    })
    // 楽観的更新は失敗時にロールバックされる
    expect(showUnownedToggle).not.toBeChecked()
  })

  it('mode!=off のときは3項目のチェックボックスもdisableされる', () => {
    renderSettings({ mode: 'read-only' }, true)
    const [, nameToggle, imageToggle, descriptionToggle] = getToggles()
    expect(nameToggle).toBeDisabled()
    expect(imageToggle).toBeDisabled()
    expect(descriptionToggle).toBeDisabled()
  })
})
