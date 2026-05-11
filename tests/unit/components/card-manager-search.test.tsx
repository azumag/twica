import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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

const renderCardManager = (cards: Card[]) => {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <CardManager streamerId="streamer-1" initialCards={cards} initialRarityWeights={{}} />
    </NextIntlClientProvider>
  )
}

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
