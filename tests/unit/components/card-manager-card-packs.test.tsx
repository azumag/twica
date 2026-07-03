import { describe, it, expect, beforeEach, vi } from 'vitest'
import { screen, fireEvent, within, waitFor } from '@testing-library/react'
import { DEFAULT_PACK_SENTINEL } from '@/lib/validation/collection-name'
import { baseCard, renderCardManager } from '../../utils/card-manager-test-helpers'

vi.mock('@/lib/logger')

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
})

// Issue #567: 登録パックが0件のとき、カード作成フォームのパック選択は
// 「未分類」1択で意味を持たないため非表示にする。ただし編集中カードが
// 孤立参照(削除済みパック名)を持つ場合は表示し、デフォルトへ戻せること。
describe('CardManager pack select visibility (Issue #567)', () => {
  it('hides the pack select when no packs are registered (create mode)', () => {
    renderCardManager([], { initialCardPackNames: [] })

    fireEvent.click(screen.getByRole('button', { name: '新規カード追加' }))

    expect(screen.queryByText('カードパック')).not.toBeInTheDocument()
    expect(document.querySelector('select[name="collectionName"]')).toBeNull()
  })

  it('shows the pack select when packs are registered (create mode)', () => {
    renderCardManager([], { initialCardPackNames: ['武器パック'] })

    fireEvent.click(screen.getByRole('button', { name: '新規カード追加' }))

    expect(screen.getByText('カードパック')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '武器パック' })).toBeInTheDocument()
  })

  it('shows the pack select for an orphaned reference even with zero registered packs (edit mode)', () => {
    renderCardManager(
      [baseCard({ id: 'orphan', name: '孤立カード', collection_name: 'ghost-pack' })],
      { initialCardPackNames: [] }
    )

    fireEvent.click(screen.getByRole('button', { name: '編集' }))

    // 孤立参照が選択肢として残り、デフォルト(未分類)にも戻せる。
    // ツールバーのパックフィルタにも孤立参照 option が並ぶため、
    // フォーム側の select にスコープして検証する。
    expect(screen.getByText('カードパック')).toBeInTheDocument()
    const formSelect = document.querySelector('select[name="collectionName"]')
    expect(formSelect).not.toBeNull()
    const optionLabels = within(formSelect as HTMLElement)
      .getAllByRole('option')
      .map((option) => option.textContent)
    expect(optionLabels).toContain('ghost-pack')
    expect(optionLabels).toContain('デフォルト（すべてのカード）')
  })

  it('keeps the pack select mounted for the whole edit session after switching an orphan reference to デフォルト', () => {
    renderCardManager(
      [baseCard({ id: 'orphan', name: '孤立カード', collection_name: 'ghost-pack' })],
      { initialCardPackNames: [] }
    )

    fireEvent.click(screen.getByRole('button', { name: '編集' }))

    // デフォルト("")へ変更しても、cardPackNames は空のままなので単純な
    // union memo だと select ごと消えてしまう(Issue #567続き)。編集中カードの
    // 元の collection_name をアンカーとして残すことで、select は消えず
    // ghost-pack option も選び直せる。
    fireEvent.change(document.querySelector('select[name="collectionName"]') as HTMLElement, {
      target: { value: '' },
    })

    let formSelect = document.querySelector('select[name="collectionName"]')
    expect(formSelect).not.toBeNull()
    const optionLabels = within(formSelect as HTMLElement)
      .getAllByRole('option')
      .map((option) => option.textContent)
    expect(optionLabels).toContain('ghost-pack')

    // 元の値へ戻せることも確認する。
    fireEvent.change(formSelect as HTMLElement, { target: { value: 'ghost-pack' } })

    formSelect = document.querySelector('select[name="collectionName"]')
    expect(formSelect).not.toBeNull()
    expect((formSelect as HTMLSelectElement).value).toBe('ghost-pack')
  })
})

// Issue #565: 確率列の母数は実際の抽選プール(executeGachaと同じ絞り込み)に
// 合わせる。パックフィルタ選択中はそのパック内で再正規化された抽選確率を表示。
describe('CardManager pack-relative probability (Issue #565)', () => {
  const packCards = [
    baseCard({ id: 'a1', name: 'A1', collection_name: 'パックA', drop_rate: 0.1 }),
    baseCard({ id: 'a2', name: 'A2', collection_name: 'パックA', drop_rate: 0.3 }),
    baseCard({ id: 'u1', name: 'U1', collection_name: null, drop_rate: 0.6 }),
  ]

  const selectPackFilter = (value: string) => {
    fireEvent.change(
      screen.getByRole('combobox', { name: 'カードパックで絞り込む' }),
      { target: { value } }
    )
  }

  const HINT = '確率はこのパックが指定された報酬から引いた場合の抽選確率です'

  it('shows probabilities against all active cards when no pack filter is selected', () => {
    renderCardManager(packCards, {
      initialCardPackNames: ['パックA'],
      viewMode: 'list',
    })

    expect(screen.getByText('10.0%')).toBeInTheDocument()
    expect(screen.getByText('30.0%')).toBeInTheDocument()
    expect(screen.getByText('60.0%')).toBeInTheDocument()
    expect(screen.queryByText(HINT)).not.toBeInTheDocument()
  })

  it('renormalizes probabilities within the selected pack and shows the hint', () => {
    renderCardManager(packCards, {
      initialCardPackNames: ['パックA'],
      viewMode: 'list',
    })

    selectPackFilter('パックA')

    // 0.1 : 0.3 → 25% : 75% (executeGacha がパック内で再正規化するのと同じ)
    expect(screen.getByText('25.0%')).toBeInTheDocument()
    expect(screen.getByText('75.0%')).toBeInTheDocument()
    expect(screen.queryByText('10.0%')).not.toBeInTheDocument()
    expect(screen.getByText(HINT)).toBeInTheDocument()
  })

  it('renormalizes within the default (unclassified) pack via the sentinel filter', () => {
    renderCardManager(packCards, {
      initialCardPackNames: ['パックA'],
      viewMode: 'list',
    })

    selectPackFilter(DEFAULT_PACK_SENTINEL)

    // 未分類は U1 のみ → 100%
    expect(screen.getByText('100.0%')).toBeInTheDocument()
    expect(screen.getByText(HINT)).toBeInTheDocument()
  })
})

// Issue #605: パック名リネーム成功時、CardPackModal はカタログ配列(パック名一覧)
// しか親に伝えられない(onSaved)。バグ修正前は、親(CardManager)が保持する
// 既存カードの collection_name が旧パック名のまま取り残され、リロードするまで
// 「別パック(孤立参照)のカード」のように見えてしまっていた。
// onPackRenamed コールバックで CardManager 側の cards ステートをローカルパッチし、
// 選択中のパックフィルタも新名へ追従することを、CardManager 経由(単体の
// CardPackModal ではなく実際の親子配線込み)でエンドツーエンドに検証する。
describe('CardManager cards follow a pack rename without a reload (Issue #605)', () => {
  const weaponsCards = [
    baseCard({ id: 'w1', name: '武器1', collection_name: 'weapons' }),
    baseCard({ id: 'w2', name: '武器2', collection_name: 'weapons' }),
  ]

  const selectPackFilter = (value: string) => {
    fireEvent.change(
      screen.getByRole('combobox', { name: 'カードパックで絞り込む' }),
      { target: { value } }
    )
  }

  it('re-associates existing cards with the new pack name and keeps an active pack filter following the rename', async () => {
    // PATCH /api/cards/collections 含め、このテストで発生する全fetchに対して
    // 一律でリネーム成功レスポンスを返す(card-pack-modal.test.tsx と同じ簡略化。
    // マウント時の /api/storage-status 取得もこれを受け取るが、storageStatus は
    // このテストでは未使用/未検証なので実害はない)。
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ success: true, cardPackNames: ['armory'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    renderCardManager(weaponsCards, {
      initialCardPackNames: ['weapons'],
      viewMode: 'list',
    })

    // リネーム前から "weapons" で絞り込んでいたユーザーのシナリオを再現する。
    selectPackFilter('weapons')
    expect(screen.getByText('武器1')).toBeInTheDocument()
    expect(screen.getByText('武器2')).toBeInTheDocument()

    // パック管理モーダルを開き、weapons → armory にインラインリネームする。
    fireEvent.click(screen.getByRole('button', { name: 'パック管理' }))
    const renameTrigger = screen.getByLabelText('Rename weapons')
    const row = renameTrigger.closest('li')!
    fireEvent.click(renameTrigger)
    fireEvent.change(within(row).getByRole('textbox'), { target: { value: 'armory' } })
    fireEvent.click(within(row).getByRole('button', { name: '保存' }))

    // モーダル内のカタログ表示が新名に切り替わるまで待つ
    // (list の key が変わるため row 参照は以降使い回さない)。
    await waitFor(() => expect(screen.queryByLabelText('Rename weapons')).not.toBeInTheDocument())
    expect(screen.getByLabelText('Rename armory')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    // 修正前: パックフィルタは "weapons" のまま残り、cards[].collection_name も
    // 旧名のままなので、絞り込み結果が(存在しないパックへの絞り込みで)空になる。
    // 修正後: フィルタは自動的に新名 "armory" へ追従し、カードも armory 所属として
    // 表示され続ける。
    const filterSelect = screen.getByRole('combobox', { name: 'カードパックで絞り込む' })
    expect(filterSelect).toHaveValue('armory')
    expect(screen.getByText('武器1')).toBeInTheDocument()
    expect(screen.getByText('武器2')).toBeInTheDocument()

    // packFilterOptions は cardPackNames ∪ cards[].collection_name の和集合な
    // ので、どちらか一方でも旧名のままだと選択肢に残ってしまう。
    const optionLabels = within(filterSelect)
      .getAllByRole('option')
      .map((option) => option.textContent)
    expect(optionLabels).toContain('armory')
    expect(optionLabels).not.toContain('weapons')
  })
})
