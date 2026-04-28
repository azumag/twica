import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import SortedCardGrid from '@/components/SortedCardGrid'
import type { Card } from '@/types/database'

// Issue #395: 未所持カードを視聴者向けに表示するときの「詳細を隠す」モードを検証する。
// hideUnownedDetails=true のとき、未所持カードは画像が表示されず、プレースホルダーテキスト ("???")
// のみが noImageText 経由で表示される。所持カードは常に画像と本来の名前で表示される。
//
// hideUnownedDetails=true: unowned cards must mask the image (placeholder text only).
// Owned cards must always render their actual name and image regardless of the flag.

const baseCard = (overrides: Partial<Card>): Card => ({
  id: 'card-1',
  streamer_id: 'streamer-1',
  name: 'カードA',
  description: 'カードAの説明',
  image_url: 'https://example.com/card-a.png',
  rarity: 'common',
  drop_rate: 25,
  intra_rarity_weight: 1,
  is_active: true,
  hp: 10,
  atk: 5,
  def: 5,
  spd: 5,
  skill_type: 'attack',
  skill_name: 'たいあたり',
  skill_power: 10,
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-01T00:00:00Z',
  ...overrides,
})

const baseTranslations = {
  cardCountTemplate: 'x{count}',
  noImage: 'NoImage',
  unownedCard: '???',
  inactiveStatus: 'PAUSED',
}

describe('SortedCardGrid - unowned card visibility (Issue #395)', () => {
  it('renders owned card with its name and image', () => {
    const cards = [
      { ...baseCard({ id: 'owned-1', name: 'OwnedCard' }), count: 2, isOwned: true },
    ]
    render(
      <SortedCardGrid
        cards={cards}
        streamerId="streamer-1"
        translations={baseTranslations}
      />
    )
    expect(screen.getByText('OwnedCard')).toBeInTheDocument()
    expect(screen.getAllByRole('img')[0]).toHaveAttribute(
      'alt',
      'OwnedCard'
    )
  })

  it('renders unowned card with masked name when hideUnownedDetails=false (legacy isOwned=false rendering)', () => {
    const cards = [
      { ...baseCard({ id: 'unowned-1', name: 'SecretCard' }), count: 0, isOwned: false },
    ]
    render(
      <SortedCardGrid
        cards={cards}
        streamerId="streamer-1"
        hideUnownedDetails={false}
        translations={baseTranslations}
      />
    )
    expect(screen.queryByText('SecretCard')).not.toBeInTheDocument()
    expect(screen.getAllByText('???').length).toBeGreaterThan(0)
    // 画像 (image_url が指定されているため <img> が描画される)
    expect(screen.getAllByRole('img').length).toBe(1)
  })

  it('hides unowned card image when hideUnownedDetails=true (placeholder only)', () => {
    const cards = [
      { ...baseCard({ id: 'unowned-1', name: 'SecretCard' }), count: 0, isOwned: false },
    ]
    render(
      <SortedCardGrid
        cards={cards}
        streamerId="streamer-1"
        hideUnownedDetails
        translations={baseTranslations}
      />
    )
    // 名前は隠される
    expect(screen.queryByText('SecretCard')).not.toBeInTheDocument()
    // 画像領域は noImageText (= unownedCard) のプレースホルダーになる
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    // "???" は名前とプレースホルダーの両方で出るため、複数あって良い
    expect(screen.getAllByText('???').length).toBeGreaterThan(0)
  })

  it('still shows owned card details even when hideUnownedDetails=true', () => {
    // 同じグリッドに所持・未所持が混在しても、所持側はマスクされない
    // Owned cards remain fully visible even when the flag is on.
    const cards = [
      { ...baseCard({ id: 'owned-1', name: 'OwnedCard' }), count: 1, isOwned: true },
      { ...baseCard({ id: 'unowned-1', name: 'SecretCard' }), count: 0, isOwned: false },
    ]
    render(
      <SortedCardGrid
        cards={cards}
        streamerId="streamer-1"
        hideUnownedDetails
        translations={baseTranslations}
      />
    )
    expect(screen.getByText('OwnedCard')).toBeInTheDocument()
    expect(screen.queryByText('SecretCard')).not.toBeInTheDocument()
    // 所持カードの画像のみが描画される（未所持は画像が伏せられる）
    const imgs = screen.getAllByRole('img')
    expect(imgs).toHaveLength(1)
    expect(imgs[0]).toHaveAttribute('alt', 'OwnedCard')
  })
})
