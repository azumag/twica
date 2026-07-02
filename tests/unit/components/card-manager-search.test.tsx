import { describe, it, expect, beforeEach, vi } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import { baseCard, renderCardManager } from '../../utils/card-manager-test-helpers'

vi.mock('@/lib/logger')

describe('CardManager title search', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
  })

  it('filters the card management list by card title', () => {
    renderCardManager([
      baseCard({ id: 'alpha', name: 'Alpha Dragon' }),
      baseCard({ id: 'beta', name: 'Beta Wizard' }),
      baseCard({ id: 'gamma', name: 'Gamma Dragon' }),
    ])

    fireEvent.change(screen.getByRole('searchbox', { name: 'カードタイトル検索' }), {
      target: { value: 'dragon' },
    })

    expect(screen.getByText('Alpha Dragon')).toBeInTheDocument()
    expect(screen.getByText('Gamma Dragon')).toBeInTheDocument()
    expect(screen.queryByText('Beta Wizard')).not.toBeInTheDocument()
    expect(screen.getByText('2 件のカード')).toBeInTheDocument()
  })

  it('defaults the management list to created_at descending order', () => {
    // デフォルトソートは設定日（created_at）降順
    // サーバー側 initialCards のソートに従う（fetch はテスト中pending）
    // そのため、initialCards を created_at 降順で渡し、表示順がそのまま維持されることを検証する
    renderCardManager([
      baseCard({ id: 'second', name: 'Second Card', card_number: 2, created_at: '2026-05-02T00:00:00Z' }),
      baseCard({ id: 'first', name: 'First Card', card_number: 1, created_at: '2026-05-01T00:00:00Z' }),
      baseCard({ id: 'auto', name: 'Auto Card', card_number: null, created_at: '2026-04-30T00:00:00Z' }),
    ])

    const text = document.body.textContent ?? ''
    expect(text.indexOf('Second Card')).toBeLessThan(text.indexOf('First Card'))
    expect(text.indexOf('First Card')).toBeLessThan(text.indexOf('Auto Card'))
  })

  it('shows a filtered empty state without replacing the no-cards message', () => {
    renderCardManager([
      baseCard({ id: 'alpha', name: 'Alpha Dragon' }),
    ])

    fireEvent.change(screen.getByRole('searchbox', { name: 'カードタイトル検索' }), {
      target: { value: 'missing' },
    })

    expect(screen.getByText('条件に一致するカードがありません。')).toBeInTheDocument()
    expect(screen.queryByText('まだカードがありません。「新規カード追加」から始めましょう。')).not.toBeInTheDocument()
  })
})
