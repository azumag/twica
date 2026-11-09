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

// 入力は確定操作（フォーカスが外れたとき）で保存される。キー入力の途中値は
// 検証も保存もされないので、実際の操作と同じく change → blur の順で再現する。
function edit(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
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
      edit(first, '3')

      await waitFor(() => expect(first).toHaveValue(4))
      const saved = JSON.parse(mockFetch.mock.calls[0][1].body).duplicateDisplayTiers
      expect(Object.prototype.hasOwnProperty.call(saved, rarity)).toBe(true)
      expect(saved[rarity]).toEqual([3])
      expect(screen.queryByText(messages.duplicateTierSettings.errors.saveFailed)).not.toBeInTheDocument()

      edit(first, '')
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
      edit(first, '4')
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

    edit(screen.getByRole('spinbutton', { name: 'コモン 1段階目' }), '3')

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

    edit(screen.getByRole('spinbutton', { name: 'レジェンダリー 2段階目' }), '7')

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

    edit(screen.getByRole('spinbutton', { name: 'レジェンダリー 1段階目' }), '')

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

    edit(screen.getByRole('spinbutton', { name: 'コモン 1段階目' }), '')

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

    edit(screen.getByRole('spinbutton', { name: 'コモン 1段階目' }), '1')

    expect(await screen.findByText(messages.duplicateTierSettings.errors.invalid)).toBeInTheDocument()
    expect(mockFetch).not.toHaveBeenCalled()
    expect(screen.getByRole('spinbutton', { name: 'コモン 1段階目' })).toHaveValue(null)
  })

  it('小さい順になっていないしきい値は弾いて元へ戻す', async () => {
    mount({ currentDuplicateDisplayTiers: { legendary: [5] } })

    edit(screen.getByRole('spinbutton', { name: 'レジェンダリー 2段階目' }), '2')

    expect(await screen.findByText(messages.duplicateTierSettings.errors.invalid)).toBeInTheDocument()
    expect(mockFetch).not.toHaveBeenCalled()
    // 楽観反映した 2 を戻し、保存済みの [5] の表示を保つ
    expect(screen.getByRole('spinbutton', { name: 'レジェンダリー 1段階目' })).toHaveValue(5)
    expect(screen.getByRole('spinbutton', { name: 'レジェンダリー 2段階目' })).toHaveValue(null)
  })

  it('保存に失敗したら画面の値を元へ戻してエラーを出す', async () => {
    mockFetch.mockImplementation(async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 }))
    mount({ currentDuplicateDisplayTiers: { common: [3] } })

    edit(screen.getByRole('spinbutton', { name: 'コモン 2段階目' }), '9')

    expect(await screen.findByText('boom')).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'コモン 1段階目' })).toHaveValue(3)
    expect(screen.getByRole('spinbutton', { name: 'コモン 2段階目' })).toHaveValue(null)
  })

  it('デプロイ窓の skip フラグが返ったら保存失敗として元へ戻す', async () => {
    mockFetch.mockImplementation(async () =>
      new Response(JSON.stringify({ success: true, duplicateDisplayTiersSkippedDeployWindow: true }))
    )
    mount()

    edit(screen.getByRole('spinbutton', { name: 'コモン 1段階目' }), '3')

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

    edit(screen.getByRole('spinbutton', { name: 'コモン 2段階目' }), '9')

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

    edit(screen.getByRole('spinbutton', { name: 'コモン 1段階目' }), '3')
    expect(mockFetch).not.toHaveBeenCalled()
  })
  it('2桁の値を1文字ずつ消しても、途中の「1」で巻き戻されず、確定時にだけ検証する', async () => {
    mount({ currentDuplicateDisplayTiers: { common: [10] } })
    const first = screen.getByRole('spinbutton', { name: 'コモン 1段階目' })

    // 「10」→「1」: 入力途中なので検証も保存もしない（以前はここで「10」へ巻き戻っていた）
    fireEvent.change(first, { target: { value: '1' } })
    expect(first).toHaveValue(1)
    expect(mockFetch).not.toHaveBeenCalled()
    expect(screen.queryByText(messages.duplicateTierSettings.errors.invalid)).not.toBeInTheDocument()

    // 「1」→「」→ 確定: 全て空 = null（機能OFF）を保存する
    fireEvent.change(first, { target: { value: '' } })
    fireEvent.blur(first)
    await waitFor(() =>
      expect(JSON.parse(mockFetch.mock.calls[0][1].body).duplicateDisplayTiers).toBeNull()
    )
  })

  it('確定時に不正な値（1）のままなら、エラーを出して保存済みの値へ戻す', async () => {
    mount({ currentDuplicateDisplayTiers: { common: [10] } })
    const first = screen.getByRole('spinbutton', { name: 'コモン 1段階目' })

    edit(first, '1')

    expect(await screen.findByText(messages.duplicateTierSettings.errors.invalid)).toBeInTheDocument()
    expect(mockFetch).not.toHaveBeenCalled()
    expect(first).toHaveValue(10)
  })

  it('小数は送らずに弾く（黙って落として別の値を保存しない）', async () => {
    mount({ currentDuplicateDisplayTiers: { common: [3] } })

    edit(screen.getByRole('spinbutton', { name: 'コモン 2段階目' }), '4.5')

    expect(await screen.findByText(messages.duplicateTierSettings.errors.invalid)).toBeInTheDocument()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('値が変わらない確定（フォーカスが通過しただけ）では保存を送らない', async () => {
    mount({ currentDuplicateDisplayTiers: { common: [3] } })

    fireEvent.blur(screen.getByRole('spinbutton', { name: 'コモン 1段階目' }))

    await waitFor(() => expect(screen.queryByText(messages.duplicateTierSettings.messages.saving)).not.toBeInTheDocument())
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('Enter キーで確定して保存する', async () => {
    mount()
    const first = screen.getByRole('spinbutton', { name: 'コモン 1段階目' })
    first.focus()
    fireEvent.change(first, { target: { value: '3' } })
    fireEvent.keyDown(first, { key: 'Enter' })

    await waitFor(() =>
      expect(JSON.parse(mockFetch.mock.calls[0][1].body).duplicateDisplayTiers).toEqual({ common: [3] })
    )
  })

  it('「すべて未設定に戻す」で全レアリティを解除（null）し、入力欄を空にする', async () => {
    mount({ currentDuplicateDisplayTiers: { common: [2, 5], legendary: [3] } })

    fireEvent.click(screen.getByRole('button', { name: messages.duplicateTierSettings.resetButton }))

    await waitFor(() =>
      expect(JSON.parse(mockFetch.mock.calls[0][1].body).duplicateDisplayTiers).toBeNull()
    )
    expect(await screen.findByText(messages.duplicateTierSettings.messages.reset)).toBeInTheDocument()
    for (const name of ['コモン 1段階目', 'コモン 2段階目', 'レジェンダリー 1段階目']) {
      expect(screen.getByRole('spinbutton', { name })).toHaveValue(null)
    }
    // 何も設定されていないのでボタンは押せない
    expect(screen.getByRole('button', { name: messages.duplicateTierSettings.resetButton })).toBeDisabled()
  })

  it('リセットに失敗したら入力欄の値を保つ', async () => {
    mockFetch.mockImplementation(async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 }))
    mount({ currentDuplicateDisplayTiers: { common: [3] } })

    fireEvent.click(screen.getByRole('button', { name: messages.duplicateTierSettings.resetButton }))

    expect(await screen.findByText('boom')).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'コモン 1段階目' })).toHaveValue(3)
  })

  it('maintenance 中はリセットボタンも無効', () => {
    render(
      <NextIntlClientProvider locale="ja" messages={messages}>
        <MaintenanceStatusContext.Provider value={{ mode: 'read-only' }}>
          <DuplicateDisplayTierSettings
            streamerId="streamer-1"
            rarities={['common']}
            currentDuplicateDisplayTiers={{ common: [3] }}
          />
        </MaintenanceStatusContext.Provider>
      </NextIntlClientProvider>
    )
    expect(screen.getByRole('button', { name: messages.duplicateTierSettings.resetButton })).toBeDisabled()
  })

  it('続けて別の欄を確定しても、保存要求は直列で、後の値が先の保存を上書きしない', async () => {
    mockFetch.mockImplementation(async (_url, init) =>
      new Response(JSON.stringify({ success: true, duplicateDisplayTiers: JSON.parse(init.body).duplicateDisplayTiers }))
    )
    mount()
    edit(screen.getByRole('spinbutton', { name: 'コモン 1段階目' }), '3')
    edit(screen.getByRole('spinbutton', { name: 'レジェンダリー 1段階目' }), '5')

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
    expect(JSON.parse(mockFetch.mock.calls[1][1].body).duplicateDisplayTiers).toEqual({
      common: [3],
      legendary: [5],
    })
  })

  // 保存の通信中に続けて入力すると、保存完了時の「確定値での上書き」で打った値が
  // 消えて見える（巻き戻り）。通信中に変えた欄は、保存結果で上書きしない。
  describe('保存の通信中に続けて入力しても、入力した値が巻き戻らない', () => {
    const echo = async (_url: unknown, init: { body: string }) =>
      new Response(
        JSON.stringify({ success: true, duplicateDisplayTiers: JSON.parse(init.body).duplicateDisplayTiers })
      )

    // 1回目の保存だけ、テスト側が解放するまで応答しない。
    function holdFirstSave(response: () => Response) {
      let release: () => void = () => {}
      mockFetch.mockImplementationOnce(
        () => new Promise<Response>((resolve) => { release = () => resolve(response()) })
      )
      mockFetch.mockImplementation(echo)
      return () => release()
    }

    it('同じレアリティの別の段階を、保存中に入力しても消えない', async () => {
      const release = holdFirstSave(
        () => new Response(JSON.stringify({ success: true, duplicateDisplayTiers: { common: [3] } }))
      )
      mount()
      const first = screen.getByRole('spinbutton', { name: 'コモン 1段階目' })
      const second = screen.getByRole('spinbutton', { name: 'コモン 2段階目' })

      edit(first, '3')
      // 保存は直列キュー経由で始まるため、実際に通信中になってから続きを入力する。
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))
      fireEvent.change(second, { target: { value: '5' } }) // 通信中に続けて入力
      release()

      // 保存の完了（成功表示）を待ってから確認する。完了前の値を見ても巻き戻りは検出できない。
      await waitFor(() => expect(screen.getByText(messages.duplicateTierSettings.messages.saved)).toBeInTheDocument())
      expect(first).toHaveValue(3)
      expect(second).toHaveValue(5) // 保存結果（2段階目は空）で巻き戻されない

      fireEvent.blur(second) // 確定すると、両方の値で保存される
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
      expect(JSON.parse(mockFetch.mock.calls[1][1].body).duplicateDisplayTiers).toEqual({ common: [3, 5] })
      await waitFor(() => expect(second).toHaveValue(5))
    })

    it('同じ欄を保存中に打ち直しても、直前の保存値へ戻らない', async () => {
      const release = holdFirstSave(
        () => new Response(JSON.stringify({ success: true, duplicateDisplayTiers: { common: [3] } }))
      )
      mount()
      const first = screen.getByRole('spinbutton', { name: 'コモン 1段階目' })

      edit(first, '3')
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1)) // 通信中
      fireEvent.change(first, { target: { value: '4' } }) // 通信中に打ち直し
      release()

      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(screen.getByText(messages.duplicateTierSettings.messages.saved)).toBeInTheDocument())
      expect(first).toHaveValue(4)

      fireEvent.blur(first)
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
      expect(JSON.parse(mockFetch.mock.calls[1][1].body).duplicateDisplayTiers).toEqual({ common: [4] })
    })

    it('保存が失敗しても、通信中に入力した別の段階は消さず、失敗した段階だけ元へ戻す', async () => {
      const release = holdFirstSave(
        () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 })
      )
      mount()
      const first = screen.getByRole('spinbutton', { name: 'コモン 1段階目' })
      const second = screen.getByRole('spinbutton', { name: 'コモン 2段階目' })

      edit(first, '3') // この保存は失敗する
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1)) // 通信中
      fireEvent.change(second, { target: { value: '5' } })
      release()

      // 保存の失敗（エラー表示）を待ってから確認する。
      await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument())
      expect(first).toHaveValue(null) // 失敗した段階は元（空）へ
      expect(second).toHaveValue(5) // 通信中の入力は残る
    })
  })
})
