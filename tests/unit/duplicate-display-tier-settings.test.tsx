import React from 'react'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import messages from '../../messages/ja.json'
import DuplicateDisplayTierSettings from '@/components/DuplicateDisplayTierSettings'
import { MaintenanceStatusContext } from '@/components/MaintenanceStatusProvider'

// Issue #1782: 被りカードの表示段階（レアリティ別の所有枚数しきい値）の設定UI。
// 変更のたびに POST /api/streamer/settings へマップ全体を送り、失敗時・不正入力時は
// 画面の値を元へ戻して「保存したつもり」を作らないことを固定する。

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

function mount(overrides: Partial<React.ComponentProps<typeof DuplicateDisplayTierSettings>> = {}) {
  return render(
    <NextIntlClientProvider locale="ja" messages={messages}>
      <DuplicateDisplayTierSettings
        streamerId="streamer-1"
        rarities={['common', 'legendary']}
        currentDuplicateDisplayTiers={{}}
        {...overrides}
      />
    </NextIntlClientProvider>
  )
}

describe('DuplicateDisplayTierSettings', () => {
  it('レアリティごとに最大3段階分のしきい値入力と、既定の日本語ラベルを出す', () => {
    mount()

    expect(screen.getByText(messages.duplicateTierSettings.title)).toBeInTheDocument()
    // 既定レアリティは RARITIES の日本語ラベルで表示する
    expect(screen.getByText('コモン')).toBeInTheDocument()
    expect(screen.getByText('レジェンダリー')).toBeInTheDocument()
    for (const rarity of ['コモン', 'レジェンダリー']) {
      for (const tier of [1, 2, 3]) {
        expect(
          screen.getByRole('spinbutton', {
            name: `${rarity} ${messages.duplicateTierSettings.thresholdLabel.replace('{tier}', String(tier))}`,
          })
        ).toBeInTheDocument()
      }
    }
  })

  it('保存済みのしきい値を初期値にする', () => {
    mount({ currentDuplicateDisplayTiers: { legendary: [2, 5] } })

    expect(screen.getByRole('spinbutton', { name: 'レジェンダリー 1段階目' })).toHaveValue(2)
    expect(screen.getByRole('spinbutton', { name: 'レジェンダリー 2段階目' })).toHaveValue(5)
    expect(screen.getByRole('spinbutton', { name: 'レジェンダリー 3段階目' })).toHaveValue(null)
    expect(screen.getByRole('spinbutton', { name: 'コモン 1段階目' })).toHaveValue(null)
  })

  it.each(['constructor', 'toString', '__proto__'])(
    '未設定の合法レアリティ名 %s を編集・保存し、確定値と機能OFFのエコーを反映する',
    async (rarity) => {
      mockFetch.mockImplementationOnce(async () =>
        new Response(JSON.stringify({ success: true, duplicateDisplayTiers: { [rarity]: [4] } }))
      ).mockImplementationOnce(async () =>
        new Response(JSON.stringify({ success: true, duplicateDisplayTiers: null }))
      )
      mount({ rarities: [rarity] })

      const first = screen.getByRole('spinbutton', { name: `${rarity} 1段階目` })
      expect(first).toHaveValue(null)
      fireEvent.change(first, { target: { value: '3' } })

      await waitFor(() => expect(first).toHaveValue(4))
      const saved = JSON.parse(mockFetch.mock.calls[0][1].body).duplicateDisplayTiers
      expect(Object.prototype.hasOwnProperty.call(saved, rarity)).toBe(true)
      expect(saved[rarity]).toEqual([3])
      expect(screen.queryByText(messages.duplicateTierSettings.errors.saveFailed)).not.toBeInTheDocument()

      fireEvent.change(first, { target: { value: '' } })
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
      expect(JSON.parse(mockFetch.mock.calls[1][1].body).duplicateDisplayTiers).toBeNull()
      await waitFor(() => expect(first).not.toBeDisabled())
      expect(first).toHaveValue(null)
      expect(screen.queryByText(messages.duplicateTierSettings.errors.saveFailed)).not.toBeInTheDocument()
    }
  )

  it('設定済みの特殊名をすべて描画し、変更した値を own JSON エントリとして全件保存する', async () => {
    const rarities = ['constructor', 'toString', '__proto__']
    const configured = JSON.parse('{"constructor":[2,7],"toString":[2,7],"__proto__":[2,7]}')
    mockFetch.mockImplementation(async (_url, init) =>
      new Response(JSON.stringify({
        success: true,
        duplicateDisplayTiers: JSON.parse(init.body).duplicateDisplayTiers,
      }))
    )
    mount({ rarities, currentDuplicateDisplayTiers: configured })

    for (const rarity of rarities) {
      expect(screen.getByRole('spinbutton', { name: `${rarity} 1段階目` })).toHaveValue(2)
      expect(screen.getByRole('spinbutton', { name: `${rarity} 2段階目` })).toHaveValue(7)
    }
    for (const [index, rarity] of rarities.entries()) {
      const first = screen.getByRole('spinbutton', { name: `${rarity} 1段階目` })
      fireEvent.change(first, { target: { value: '4' } })
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(index + 1))
      await waitFor(() => expect(first).not.toBeDisabled())

      const saved = JSON.parse(mockFetch.mock.calls[index][1].body).duplicateDisplayTiers
      expect(Object.getPrototypeOf(saved)).toBe(Object.prototype)
      for (const [entryIndex, name] of rarities.entries()) {
        expect(Object.prototype.hasOwnProperty.call(saved, name)).toBe(true)
        expect(saved[name]).toEqual([entryIndex <= index ? 4 : 2, 7])
      }
      expect(first).toHaveValue(4)
    }
  })

  it('しきい値を入力するとマップ全体を保存する', async () => {
    mount()

    fireEvent.change(screen.getByRole('spinbutton', { name: 'コモン 1段階目' }), {
      target: { value: '3' },
    })

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/streamer/settings',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            streamerId: 'streamer-1',
            duplicateDisplayTiers: { common: [3] },
          }),
        })
      )
    )
    expect(await screen.findByText(messages.duplicateTierSettings.messages.saved)).toBeInTheDocument()
  })

  it('既存の段階に追加すると、そのレアリティの段階が増える', async () => {
    mount({ currentDuplicateDisplayTiers: { legendary: [2] } })

    fireEvent.change(screen.getByRole('spinbutton', { name: 'レジェンダリー 2段階目' }), {
      target: { value: '7' },
    })

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/streamer/settings',
        expect.objectContaining({
          body: JSON.stringify({
            streamerId: 'streamer-1',
            duplicateDisplayTiers: { legendary: [2, 7] },
          }),
        })
      )
    )
  })

  it('空欄は常に末尾へ寄せる（穴あき配列を送らない）', async () => {
    // 1段階目を空欄にすると、2段階目に入っていた値が1段階目に繰り上がる。
    // 繰り上げないと「配列の穴」ができ、厳密増加の検証で毎回 400 になる。
    mount({ currentDuplicateDisplayTiers: { legendary: [2, 5] } })

    fireEvent.change(screen.getByRole('spinbutton', { name: 'レジェンダリー 1段階目' }), {
      target: { value: '' },
    })

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/streamer/settings',
        expect.objectContaining({
          body: JSON.stringify({
            streamerId: 'streamer-1',
            duplicateDisplayTiers: { legendary: [5] },
          }),
        })
      )
    )
  })

  it('すべて空にすると null（機能OFF）を保存する', async () => {
    mount({ currentDuplicateDisplayTiers: { common: [3] } })

    fireEvent.change(screen.getByRole('spinbutton', { name: 'コモン 1段階目' }), {
      target: { value: '' },
    })

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/streamer/settings',
        expect.objectContaining({
          body: JSON.stringify({
            streamerId: 'streamer-1',
            duplicateDisplayTiers: null,
          }),
        })
      )
    )
  })

  it('しきい値 1 は弾いて元へ戻す（1枚は「被り」ではない）', async () => {
    mount()

    fireEvent.change(screen.getByRole('spinbutton', { name: 'コモン 1段階目' }), {
      target: { value: '1' },
    })

    expect(await screen.findByText(messages.duplicateTierSettings.errors.invalid)).toBeInTheDocument()
    expect(mockFetch).not.toHaveBeenCalled()
    expect(screen.getByRole('spinbutton', { name: 'コモン 1段階目' })).toHaveValue(null)
  })

  it('小さい順になっていないしきい値は弾いて元へ戻す', async () => {
    mount({ currentDuplicateDisplayTiers: { legendary: [5] } })

    fireEvent.change(screen.getByRole('spinbutton', { name: 'レジェンダリー 2段階目' }), {
      target: { value: '2' },
    })

    expect(await screen.findByText(messages.duplicateTierSettings.errors.invalid)).toBeInTheDocument()
    expect(mockFetch).not.toHaveBeenCalled()
    // 楽観反映した 2 を戻し、保存済みの [5] の表示を保つ
    expect(screen.getByRole('spinbutton', { name: 'レジェンダリー 1段階目' })).toHaveValue(5)
    expect(screen.getByRole('spinbutton', { name: 'レジェンダリー 2段階目' })).toHaveValue(null)
  })

  it('保存に失敗したら画面の値を元へ戻してエラーを出す', async () => {
    mockFetch.mockImplementation(async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 }))
    mount({ currentDuplicateDisplayTiers: { common: [3] } })

    fireEvent.change(screen.getByRole('spinbutton', { name: 'コモン 2段階目' }), {
      target: { value: '9' },
    })

    expect(await screen.findByText('boom')).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'コモン 1段階目' })).toHaveValue(3)
    expect(screen.getByRole('spinbutton', { name: 'コモン 2段階目' })).toHaveValue(null)
  })

  it('デプロイ窓の skip フラグが返ったら保存失敗として元へ戻す', async () => {
    mockFetch.mockImplementation(async () =>
      new Response(JSON.stringify({ success: true, duplicateDisplayTiersSkippedDeployWindow: true }))
    )
    mount()

    fireEvent.change(screen.getByRole('spinbutton', { name: 'コモン 1段階目' }), {
      target: { value: '3' },
    })

    expect(
      await screen.findByText(messages.duplicateTierSettings.errors.unavailable)
    ).toBeInTheDocument()
    // 未保存の値を保存済みに見せない
    expect(screen.getByRole('spinbutton', { name: 'コモン 1段階目' })).toHaveValue(null)
  })

  it('サーバからエコーバックされた確定値で表示を同期する', async () => {
    mockFetch.mockImplementation(async () =>
      new Response(JSON.stringify({ success: true, duplicateDisplayTiers: { common: [4, 8] } }))
    )
    mount()

    fireEvent.change(screen.getByRole('spinbutton', { name: 'コモン 2段階目' }), {
      target: { value: '9' },
    })

    await waitFor(() =>
      expect(screen.getByRole('spinbutton', { name: 'コモン 2段階目' })).toHaveValue(8)
    )
    expect(screen.getByRole('spinbutton', { name: 'コモン 1段階目' })).toHaveValue(4)
  })

  it('maintenance 中は入力を無効化して保存を送らない', () => {
    render(
      <NextIntlClientProvider locale="ja" messages={messages}>
        <MaintenanceStatusContext.Provider value={{ mode: 'read-only' }}>
          <DuplicateDisplayTierSettings
            streamerId="streamer-1"
            rarities={['common']}
            currentDuplicateDisplayTiers={{}}
          />
        </MaintenanceStatusContext.Provider>
      </NextIntlClientProvider>
    )

    expect(screen.getByRole('spinbutton', { name: 'コモン 1段階目' })).toBeDisabled()
    expect(screen.getByText(messages.maintenance.writeDisabled)).toBeInTheDocument()

    fireEvent.change(screen.getByRole('spinbutton', { name: 'コモン 1段階目' }), {
      target: { value: '3' },
    })
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
