import { describe, it, expect, beforeEach, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { baseCard, renderCardManager } from '../../utils/card-manager-test-helpers'

vi.mock('@/lib/logger')

// Issue #542: CardManagerで発行済み枚数・残余枚数を表示する
//
// 受け入れ条件:
// - max_issuance_count が設定されたカードに 発行済み/上限 の枚数が表示される
// - 上限到達カードに「売り切れ」バッジが表示される
// - 残り10%以下のカードに警告表示がある
// - max_issuance_count = null（無制限）カードには枚数表示が出ない

describe('CardManager issuance count display (Issue #542)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // reloadCards()のfetchはpendingのままにして、initialCardsのみで検証する
    // (他のCardManagerテストと同じパターン)
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
  })

  describe('thumbnail grid view (default)', () => {
    it('shows no issuance text for an unlimited card', () => {
      renderCardManager([
        baseCard({ id: 'unlimited', name: 'Unlimited Card', max_issuance_count: null }),
      ])

      expect(screen.getByText('Unlimited Card')).toBeInTheDocument()
      expect(screen.queryByText(/発行済み/)).not.toBeInTheDocument()
      expect(screen.queryByText('売り切れ')).not.toBeInTheDocument()
      expect(screen.queryByText('残りわずか')).not.toBeInTheDocument()
    })

    it('shows "issued / max 発行済み" for a limited card with plenty of stock left', () => {
      renderCardManager([
        baseCard({ id: 'limited', name: 'Limited Card', max_issuance_count: 10, issued_count: 3 }),
      ])

      expect(screen.getByText('3 / 10 発行済み')).toBeInTheDocument()
      expect(screen.queryByText('売り切れ')).not.toBeInTheDocument()
      expect(screen.queryByText('残りわずか')).not.toBeInTheDocument()
    })

    it('shows a "売り切れ" banner once issued reaches the cap', () => {
      renderCardManager([
        baseCard({ id: 'sold-out', name: 'Sold Out Card', max_issuance_count: 5, issued_count: 5 }),
      ])

      expect(screen.getByText('5 / 5 発行済み')).toBeInTheDocument()
      expect(screen.getByText('売り切れ')).toBeInTheDocument()
      expect(screen.queryByText('残りわずか')).not.toBeInTheDocument()
    })

    it('shows a "残りわずか" banner once remaining stock drops to 10% or below', () => {
      renderCardManager([
        baseCard({ id: 'low', name: 'Low Stock Card', max_issuance_count: 10, issued_count: 9 }),
      ])

      expect(screen.getByText('9 / 10 発行済み')).toBeInTheDocument()
      expect(screen.getByText('残りわずか')).toBeInTheDocument()
      expect(screen.queryByText('売り切れ')).not.toBeInTheDocument()
    })

    it('treats a missing issued_count (e.g. join skipped) as 0 issued', () => {
      renderCardManager([
        baseCard({ id: 'no-count', name: 'No Count Card', max_issuance_count: 10, issued_count: undefined }),
      ])

      expect(screen.getByText('0 / 10 発行済み')).toBeInTheDocument()
    })
  })

  describe('list (table) view', () => {
    it('shows "-" in the issuance column for an unlimited card', () => {
      renderCardManager(
        [baseCard({ id: 'unlimited', name: 'Unlimited Card', max_issuance_count: null })],
        { viewMode: 'list' }
      )

      expect(screen.getByText('Unlimited Card')).toBeInTheDocument()
      expect(screen.queryByText(/発行済み/)).not.toBeInTheDocument()
      // 発行数列ヘッダーは存在する
      expect(screen.getByText('発行数')).toBeInTheDocument()
    })

    it('shows the issued/max count and a sold-out badge for a fully-issued card', () => {
      renderCardManager(
        [baseCard({ id: 'sold-out', name: 'Sold Out Card', max_issuance_count: 1, issued_count: 1 })],
        { viewMode: 'list' }
      )

      expect(screen.getByText('1 / 1 発行済み')).toBeInTheDocument()
      expect(screen.getByText('売り切れ')).toBeInTheDocument()
    })

    it('shows a low-remaining badge without a sold-out badge near the limit', () => {
      renderCardManager(
        [baseCard({ id: 'low', name: 'Low Stock Card', max_issuance_count: 10, issued_count: 9 })],
        { viewMode: 'list' }
      )

      expect(screen.getByText('9 / 10 発行済み')).toBeInTheDocument()
      expect(screen.getByText('残りわずか')).toBeInTheDocument()
      expect(screen.queryByText('売り切れ')).not.toBeInTheDocument()
    })
  })
})
