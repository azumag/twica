import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import CardManager from '@/components/CardManager'
import jaMessages from '../../../messages/ja.json'
import type { Card } from '@/types/database'

vi.mock('@/lib/logger')

const baseCard = (overrides: Partial<Card>): Card => ({
  id: 'card-1',
  streamer_id: 'streamer-1',
  name: 'カードA',
  description: '',
  image_url: null,
  rarity: 'common',
  card_number: null,
  collection_name: null,
  drop_rate: 0.25,
  intra_rarity_weight: 1,
  is_active: true,
  hp: 10,
  atk: 5,
  def: 5,
  spd: 5,
  skill_type: 'attack',
  skill_name: 'たいあたり',
  skill_power: 10,
  created_at: '2026-05-01T00:00:00Z',
  updated_at: '2026-05-01T00:00:00Z',
  ...overrides,
})

const renderCardManager = (
  cards: Card[],
  props: Partial<React.ComponentProps<typeof CardManager>> = {}
) => {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <CardManager
        streamerId="streamer-1"
        initialCards={cards}
        initialRarityWeights={{}}
        {...props}
      />
    </NextIntlClientProvider>
  )
}

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
})
