import { describe, it, expect, beforeEach, vi } from 'vitest'
import { screen, fireEvent, within } from '@testing-library/react'
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

  const HINT = '確率はこのパックが指定されたチャネルポイント引き換えから引いた場合の抽選確率です'

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
