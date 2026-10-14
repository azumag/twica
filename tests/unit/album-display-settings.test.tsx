import React from 'react'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import messages from '../../messages/ja.json'
import AlbumDisplaySettings from '@/components/AlbumDisplaySettings'
import { MaintenanceStatusContext } from '@/components/MaintenanceStatusProvider'

// #1765 フォローアップ: パック別アルバム既定（並び N×N）と初期表示の設定UI。
// 変更のたびに POST /api/streamer/settings へマップ全体を送り、失敗時は
// 画面の値を元へ戻す（保存したつもりを作らない）ことを固定する。

const mockFetch = vi.fn()

beforeEach(() => {
  mockFetch.mockReset()
  mockFetch.mockImplementation(async () => new Response(JSON.stringify({ success: true })))
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function mount(overrides: Partial<React.ComponentProps<typeof AlbumDisplaySettings>> = {}) {
  return render(
    <NextIntlClientProvider locale="ja" messages={messages}>
      <AlbumDisplaySettings
        streamerId="streamer-1"
        packNames={['weapons', 'armors']}
        defaultPackName="基本パック"
        currentAlbumGridSizes={{ __all__: 6, weapons: 9 }}
        currentAlbumDefaultView="grid"
        {...overrides}
      />
    </NextIntlClientProvider>
  )
}

describe('AlbumDisplaySettings', () => {
  it('すべて / デフォルト / 各パックの行を出し、保存済みの並びを初期値にする', () => {
    mount()

    expect(screen.getByText(messages.albumDisplaySettings.title)).toBeInTheDocument()
    expect(screen.getByText(messages.albumDisplaySettings.allPacks)).toBeInTheDocument()
    expect(screen.getByText('基本パック')).toBeInTheDocument()
    expect(screen.getByText('weapons')).toBeInTheDocument()
    expect(screen.getByText('armors')).toBeInTheDocument()

    expect(screen.getByRole('combobox', { name: 'すべてのパック 並び' })).toHaveValue('6')
    expect(screen.getByRole('combobox', { name: 'weapons 並び' })).toHaveValue('9')
    // 未設定のパックは「既定」（= __all__ に従う）
    expect(screen.getByRole('combobox', { name: 'armors 並び' })).toHaveValue('')
  })

  it('並びを変更するとマップ全体を保存する', async () => {
    mount()

    fireEvent.change(screen.getByRole('combobox', { name: 'armors 並び' }), {
      target: { value: '3' },
    })

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/streamer/settings',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            streamerId: 'streamer-1',
            packAlbumGridSizes: { __all__: 6, weapons: 9, armors: 3 },
          }),
        })
      )
    )
    expect(await screen.findByText(messages.albumDisplaySettings.messages.saved)).toBeInTheDocument()
  })

  it('「既定」を選ぶとそのパックの指定を削除して保存する', async () => {
    mount()

    fireEvent.change(screen.getByRole('combobox', { name: 'weapons 並び' }), {
      target: { value: '' },
    })

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/streamer/settings',
        expect.objectContaining({
          body: JSON.stringify({
            streamerId: 'streamer-1',
            packAlbumGridSizes: { __all__: 6 },
          }),
        })
      )
    )
    expect(screen.getByRole('combobox', { name: 'weapons 並び' })).toHaveValue('')
  })

  it('初期表示をアルバムに切り替えると default view を保存する', async () => {
    mount()

    fireEvent.click(screen.getByRole('button', { name: messages.albumDisplaySettings.viewAlbum }))

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/streamer/settings',
        expect.objectContaining({
          body: JSON.stringify({
            streamerId: 'streamer-1',
            collectionDefaultView: 'album',
          }),
        })
      )
    )
    expect(
      screen.getByRole('button', { name: messages.albumDisplaySettings.viewAlbum })
    ).toHaveAttribute('aria-pressed', 'true')
  })

  it('保存に失敗したら画面の値を元へ戻してエラーを出す', async () => {
    mockFetch.mockImplementation(async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 }))
    mount()

    fireEvent.change(screen.getByRole('combobox', { name: 'armors 並び' }), {
      target: { value: '3' },
    })

    expect(await screen.findByText('boom')).toBeInTheDocument()
    // 楽観反映した値を戻す（未保存の値を保存済みに見せない）
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'armors 並び' })).toHaveValue('')
    )
  })

  it('maintenance 中は変更できない（書き込みを送らない）', () => {
    render(
      <NextIntlClientProvider locale="ja" messages={messages}>
        <MaintenanceStatusContext.Provider value={{ mode: 'read-only' }}>
          <AlbumDisplaySettings
            streamerId="streamer-1"
            packNames={['weapons']}
            defaultPackName={null}
            currentAlbumGridSizes={{ __all__: 3 }}
            currentAlbumDefaultView="grid"
          />
        </MaintenanceStatusContext.Provider>
      </NextIntlClientProvider>
    )

    expect(screen.getByRole('combobox', { name: 'weapons 並び' })).toBeDisabled()
    fireEvent.change(screen.getByRole('combobox', { name: 'weapons 並び' }), {
      target: { value: '9' },
    })
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
