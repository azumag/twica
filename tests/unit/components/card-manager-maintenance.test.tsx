import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { baseCard, renderCardManager } from '../../utils/card-manager-test-helpers'

vi.mock('@/lib/logger')

// #694 Stage 6b: 「カード管理」カテゴリの代表として CardManager の
// 追加/更新フォーム（/api/cards, /api/cards/[id] への書き込み）を検証する。
describe('CardManager maintenance integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mode=off のときは保存ボタンが操作可能（既存挙動を壊さない）', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    renderCardManager([baseCard({ id: 'a', name: 'カードA' })], {}, { mode: 'off' })

    fireEvent.click(screen.getByText('新規カード追加'))

    const submitButton = screen.getByRole('button', { name: '追加' })
    expect(submitButton).not.toBeDisabled()
    expect(screen.queryByText('メンテナンス中は操作できません')).not.toBeInTheDocument()
  })

  it('mode!=off のときは保存ボタンがdisableされ、案内文言が表示される（事前disable）', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    renderCardManager(
      [baseCard({ id: 'a', name: 'カードA' })],
      {},
      { mode: 'read-only' }
    )

    fireEvent.click(screen.getByText('新規カード追加'))

    const submitButton = screen.getByRole('button', { name: '追加' })
    expect(submitButton).toBeDisabled()
    expect(screen.getByText('メンテナンス中は操作できません')).toBeInTheDocument()
  })

  it('cutover-validating でも同様にdisableされる', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    renderCardManager(
      [baseCard({ id: 'a', name: 'カードA' })],
      {},
      { mode: 'cutover-validating' }
    )

    fireEvent.click(screen.getByText('新規カード追加'))
    expect(screen.getByRole('button', { name: '追加' })).toBeDisabled()
  })

  it('事前disableをすり抜けてフォーム送信された場合（例: Enterキー）も、送信前にガードしてサーバーへfetchしない', async () => {
    const fetchMock = vi.fn(() => new Promise(() => {}))
    vi.stubGlobal('fetch', fetchMock)
    renderCardManager(
      [baseCard({ id: 'a', name: 'カードA' })],
      {},
      { mode: 'read-only' }
    )

    fireEvent.click(screen.getByText('新規カード追加'))

    // disabled submit buttonでもフォーム自体のonSubmitハンドラは
    // 呼び出せるため、form.submit相当のイベントでhandleSubmit内の
    // 早期returnガードを直接検証する（例: 入力欄でのEnterキー送信を模した経路）。
    const form = document.querySelector('form') as HTMLFormElement
    expect(form).not.toBeNull()
    fireEvent.submit(form)

    await waitFor(() => {
      // 事前disable用の案内文言（常時表示）とhandleSubmitのガードが設定する
      // uploadErrorの2箇所から同じ文言が出るため、複数要素を許容してカウントで検証する
      expect(screen.getAllByText('メンテナンス中は操作できません').length).toBeGreaterThan(0)
    })
    // handleSubmit内のガードで早期returnするため、/api/cardsへの書き込みfetchは
    // 発生しない（マウント時の/api/storage-status取得(GET)は無関係のため対象外）
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/cards",
      expect.anything()
    )
  })

  // レビュー指摘対応（#694 Stage 6b再レビュー）: 追加/編集フォーム以外の
  // 書き込み経路（配布停止トグル・完全削除・エモート一括インポート・
  // カード番号一括編集）は、maintenance mode の503エラーを
  // parseMaintenanceError() でパースせず`errorData.error`（オブジェクト）を
  // そのまま文字列化していたため "[object Object]" と表示されていた。
  // 事前disableまでは求められていない（issueの受け入れ条件は「disable
  // または送信後の明確な案内」）ため、ここでは各経路が503応答時に
  // サーバーの案内文言をそのまま表示することだけを検証する。
  function maintenanceErrorResponse(message = 'ただいまメンテナンス中です。しばらくしてから再度お試しください。') {
    return new Response(
      JSON.stringify({
        error: { code: 'maintenance_read_only', message, retryable: true },
      }),
      { status: 503 }
    )
  }

  it('配布停止トグル(handleToggleActive)がmaintenance 503を受け取ったら、サーバーの案内文言をalertで表示する（[object Object]にならない）', async () => {
    const alertMock = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const fetchMock = vi.fn().mockResolvedValue(maintenanceErrorResponse())
    vi.stubGlobal('fetch', fetchMock)

    renderCardManager([baseCard({ id: 'a', name: 'カードA', is_active: true })], {}, { mode: 'off' })

    fireEvent.click(screen.getByRole('button', { name: '配布停止' }))

    await waitFor(() => {
      expect(alertMock).toHaveBeenCalledWith(
        '操作に失敗しました: ただいまメンテナンス中です。しばらくしてから再度お試しください。'
      )
    })
    expect(alertMock.mock.calls.some(([msg]) => String(msg).includes('[object Object]'))).toBe(false)

    alertMock.mockRestore()
  })

  it('完全削除(handleDelete)がmaintenance 503を受け取ったら、サーバーの案内文言をalertで表示する（[object Object]にならない）', async () => {
    const confirmMock = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const alertMock = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const fetchMock = vi.fn().mockResolvedValue(maintenanceErrorResponse())
    vi.stubGlobal('fetch', fetchMock)

    renderCardManager([baseCard({ id: 'a', name: 'カードA' })], {}, { mode: 'off' })

    fireEvent.click(screen.getByRole('button', { name: '完全削除' }))

    await waitFor(() => {
      expect(alertMock).toHaveBeenCalledWith(
        '削除失敗: ただいまメンテナンス中です。しばらくしてから再度お試しください。'
      )
    })
    expect(alertMock.mock.calls.some(([msg]) => String(msg).includes('[object Object]'))).toBe(false)

    confirmMock.mockRestore()
    alertMock.mockRestore()
  })

  it('エモート一括インポート(createCardsFromEmotes)がmaintenance 503を受け取ったら、モーダル内にサーバーの案内文言を表示する（[object Object]にならない）', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (String(url).includes('/api/twitch/emotes')) {
        return Promise.resolve({
          ok: true,
          json: async () => ([
            { id: 'e1', name: 'PogChamp', imageUrl: 'https://example.com/e1.png', tier: '1', emoteType: 'subscriptions' },
          ]),
        })
      }
      if (String(url).includes('/api/cards/batch')) {
        return Promise.resolve(maintenanceErrorResponse())
      }
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })
    vi.stubGlobal('fetch', fetchMock)

    renderCardManager([baseCard({ id: 'a', name: 'カードA' })], {}, { mode: 'off' })

    fireEvent.click(screen.getByText('エモートからインポート'))
    await screen.findByText('全て選択')
    fireEvent.click(screen.getByText('全て選択'))
    fireEvent.click(screen.getByRole('button', { name: /件のカードを作成/ }))

    await waitFor(() => {
      expect(
        screen.getByText('ただいまメンテナンス中です。しばらくしてから再度お試しください。')
      ).toBeInTheDocument()
    })
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument()
  })

  it('カード番号一括編集(saveCardNumbers)がmaintenance 503を受け取ったら、モーダル内にサーバーの案内文言を表示する（[object Object]にならない）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(maintenanceErrorResponse())
    vi.stubGlobal('fetch', fetchMock)

    renderCardManager(
      [baseCard({ id: 'a', name: 'カードA', card_number: null })],
      {},
      { mode: 'off' }
    )

    fireEvent.click(screen.getByText('番号をまとめて編集'))
    const numberInput = await screen.findByLabelText('番号')
    fireEvent.change(numberInput, { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: '番号を保存' }))

    await waitFor(() => {
      expect(
        screen.getByText('ただいまメンテナンス中です。しばらくしてから再度お試しください。')
      ).toBeInTheDocument()
    })
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument()
  })
})
