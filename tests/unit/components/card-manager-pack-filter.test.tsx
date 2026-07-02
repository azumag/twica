import { describe, it, expect, beforeEach, vi } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import CardManager from '@/components/CardManager'
import { baseCard, renderCardManager as renderCardManagerBase } from '../../utils/card-manager-test-helpers'
import type { Card } from '@/types/database'

vi.mock('@/lib/logger')

// Issue #554: パックフィルタ。カタログ(initialCardPackNames) ∪ カード上に
// 実在する collection_name(パック管理から削除された孤立参照)を選択肢とし、
// デフォルト(未分類, collection_name === null)選択時はそのカードのみに絞る。

const renderCardManager = (
  cards: Card[],
  props: Partial<React.ComponentProps<typeof CardManager>> = {}
) => renderCardManagerBase(cards, { initialCardPackNames: ['weapons'], ...props })

describe('CardManager pack filter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
  })

  it('shows all cards by default (no pack filter applied)', () => {
    renderCardManager([
      baseCard({ id: 'a', name: 'Weapon Card', collection_name: 'weapons' }),
      baseCard({ id: 'b', name: 'Unclassified Card', collection_name: null }),
    ])

    expect(screen.getByText('Weapon Card')).toBeInTheDocument()
    expect(screen.getByText('Unclassified Card')).toBeInTheDocument()
  })

  it('filters to only unclassified cards when the default pseudo-pack is selected', () => {
    renderCardManager([
      baseCard({ id: 'a', name: 'Weapon Card', collection_name: 'weapons' }),
      baseCard({ id: 'b', name: 'Unclassified Card', collection_name: null }),
    ])

    fireEvent.change(screen.getByLabelText('カードパックで絞り込む'), {
      target: { value: '__default__' },
    })

    expect(screen.queryByText('Weapon Card')).not.toBeInTheDocument()
    expect(screen.getByText('Unclassified Card')).toBeInTheDocument()
  })

  it('filters to a specific catalog pack by exact collection_name match', () => {
    renderCardManager(
      [
        baseCard({ id: 'a', name: 'Weapon Card', collection_name: 'weapons' }),
        baseCard({ id: 'b', name: 'Character Card', collection_name: 'characters' }),
        baseCard({ id: 'c', name: 'Unclassified Card', collection_name: null }),
      ],
      { initialCardPackNames: ['weapons', 'characters'] }
    )

    fireEvent.change(screen.getByLabelText('カードパックで絞り込む'), {
      target: { value: 'characters' },
    })

    expect(screen.getByText('Character Card')).toBeInTheDocument()
    expect(screen.queryByText('Weapon Card')).not.toBeInTheDocument()
    expect(screen.queryByText('Unclassified Card')).not.toBeInTheDocument()
  })

  it('includes an orphaned collection_name (removed from the catalog) as a filter option', () => {
    renderCardManager(
      [
        baseCard({ id: 'a', name: 'Orphaned Card', collection_name: 'discontinued-pack' }),
        baseCard({ id: 'b', name: 'Weapon Card', collection_name: 'weapons' }),
      ],
      { initialCardPackNames: ['weapons'] } // "discontinued-pack" was removed from the catalog
    )

    // The orphaned pack name still appears as a selectable filter option...
    expect(
      screen.getByRole('option', { name: 'discontinued-pack' })
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('カードパックで絞り込む'), {
      target: { value: 'discontinued-pack' },
    })

    // ...and filtering by it still works (the card isn't hidden just because
    // its pack was deleted from the management list).
    expect(screen.getByText('Orphaned Card')).toBeInTheDocument()
    expect(screen.queryByText('Weapon Card')).not.toBeInTheDocument()
  })

  it('shows the custom default-pack display name as the default filter option label', () => {
    renderCardManager(
      [baseCard({ id: 'a', name: 'Unclassified Card', collection_name: null })],
      { initialDefaultPackName: 'オリジナルカード' }
    )

    expect(screen.getByRole('option', { name: 'オリジナルカード' })).toBeInTheDocument()
  })
})
