import { describe, it, expect, beforeEach, vi } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { baseCard, renderCardManager } from '../../utils/card-manager-test-helpers'
import jaMessages from '../../../messages/ja.json'

vi.mock('@/lib/logger')

// Issue #1790: カード編集フォームの「トレードで求めるカードに指定できる」トグル。
//
// - 既存カードの編集時だけ表示する（新規作成は既定の指定可）
// - 初期値は initialNonWantableCardIds（cards.trade_wantable = false の id）から決まる
// - 保存時に tradeWantable を PUT へ送り、応答の trade_wantable で状態を更新する
//   （カード行は本体の RETURNING で丸ごと置き換わるため、行には持たない）

const LABEL = jaMessages.cardManager.form.tradeWantable

function putResponse(body: Record<string, unknown>) {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  )
}

describe('CardManager trade wantable toggle (Issue #1790)', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    // PUT 以外（ストレージ状態など）は pending のままにして initialCards だけで検証する
    fetchMock = vi.fn(() => new Promise(() => {}))
    vi.stubGlobal('fetch', fetchMock)
  })

  it('is not shown on the new-card form', () => {
    renderCardManager([baseCard({ id: 'card-1', name: 'Coin' })])
    fireEvent.click(screen.getByRole('button', { name: '新規カード追加' }))
    expect(screen.queryByRole('checkbox', { name: LABEL })).not.toBeInTheDocument()
  })

  it('is checked for a wantable card and unchecked for a card listed in initialNonWantableCardIds', () => {
    renderCardManager(
      [baseCard({ id: 'card-1', name: 'Coin' }), baseCard({ id: 'card-2', name: 'Rare Item' })],
      { initialNonWantableCardIds: ['card-2'] }
    )
    const editButtons = screen.getAllByRole('button', { name: '編集' })

    fireEvent.click(editButtons[0])
    expect(screen.getByRole('checkbox', { name: LABEL })).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))

    fireEvent.click(screen.getAllByRole('button', { name: '編集' })[1])
    expect(screen.getByRole('checkbox', { name: LABEL })).not.toBeChecked()
  })

  it('does not send tradeWantable when the toggle was not changed (stale cached value must not be written back)', async () => {
    const card = baseCard({ id: 'card-2', name: 'Rare Item' })
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/cards/card-2' && init?.method === 'PUT') {
        return putResponse({ ...card, name: 'Renamed', recalculatedCards: null })
      }
      return new Promise(() => {})
    })
    // 実際は指定不可でも、画面の状態が古い（指定可に見える）ケースを想定
    renderCardManager([card])

    fireEvent.click(screen.getByRole('button', { name: '編集' }))
    fireEvent.change(document.querySelector('input[name="name"]') as HTMLInputElement, {
      target: { value: 'Renamed' },
    })
    fireEvent.submit(document.querySelector('form') as HTMLFormElement)

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        ([url, init]) => url === '/api/cards/card-2' && (init as RequestInit | undefined)?.method === 'PUT'
      )
      expect(put).toBeDefined()
      const body = JSON.parse((put![1] as RequestInit).body as string)
      expect(body).toMatchObject({ name: 'Renamed' })
      expect(body).not.toHaveProperty('tradeWantable')
    })
  })

  it('shows a notice when the server could not save the setting (deploy window)', async () => {
    const card = baseCard({ id: 'card-1', name: 'Rare Item' })
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/cards/card-1' && init?.method === 'PUT') {
        return putResponse({
          ...card,
          trade_wantable: true,
          tradeWantableSkippedDeployWindow: true,
          recalculatedCards: null,
        })
      }
      return new Promise(() => {})
    })
    renderCardManager([card])

    fireEvent.click(screen.getByRole('button', { name: '編集' }))
    fireEvent.click(screen.getByRole('checkbox', { name: LABEL }))
    fireEvent.submit(document.querySelector('form') as HTMLFormElement)

    expect(await screen.findByText(jaMessages.cardManager.form.tradeWantableDeployWindow)).toBeInTheDocument()
    // 保存されなかった（実際の値は指定可）ので、次に開くと指定可のまま
    fireEvent.click(screen.getByRole('button', { name: '編集' }))
    expect(screen.getByRole('checkbox', { name: LABEL })).toBeChecked()
  })

  it('sends tradeWantable on save and keeps the saved value for the next edit', async () => {
    const card = baseCard({ id: 'card-1', name: 'Rare Item' })
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/cards/card-1' && init?.method === 'PUT') {
        // 本体の RETURNING 行（trade_wantable を含まない）+ 保存後の指定可否
        return putResponse({ ...card, trade_wantable: false, recalculatedCards: null })
      }
      return new Promise(() => {})
    })
    renderCardManager([card])

    fireEvent.click(screen.getByRole('button', { name: '編集' }))
    const checkbox = screen.getByRole('checkbox', { name: LABEL })
    fireEvent.click(checkbox)
    expect(checkbox).not.toBeChecked()
    // jsdom の暗黙送信は制約検証（画像 URL 等）に左右されるため、他の
    // CardManager テストと同じく form の submit を直接発火する。
    fireEvent.submit(document.querySelector('form') as HTMLFormElement)

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        ([url, init]) => url === '/api/cards/card-1' && (init as RequestInit | undefined)?.method === 'PUT'
      )
      expect(put).toBeDefined()
      expect(JSON.parse((put![1] as RequestInit).body as string)).toMatchObject({ tradeWantable: false })
    })
    // 保存後はフォームが閉じる。再度開くと保存後の値（指定不可）が出る。
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: LABEL })).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '編集' }))
    expect(screen.getByRole('checkbox', { name: LABEL })).not.toBeChecked()
  })
})
