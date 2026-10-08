import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import CardAlbumView from '@/components/CardAlbumView'
import type { AlbumCard, AlbumTranslations } from '@/components/CardAlbumView'
import SortedCardGrid from '@/components/SortedCardGrid'
import type { Card } from '@/types/database'

// next-intl は ExpandableDescription（SortedCardGrid 経由）だけが必要とするため、
// sorted-card-grid.test.tsx と同じ最小モックで足りる。
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = { expand: '開く', collapse: '閉じる' }
    return map[key] ?? key
  },
}))

// Issue #1765（視聴者からの機能要望「カードアルバム機能」）:
// - 端末幅で列数が変わらない 3×3 固定の並び
// - 名前・レアリティを出さない画像のみのタイル
// - ページ送りで全カードを閲覧できる
// - 未所持カードは画像を出さず空きスロットとして残す

const albumTranslations: AlbumTranslations = {
  viewLabel: '表示',
  gridView: 'カード',
  albumView: 'アルバム',
  pageIndicator: '{page} / {total}',
  prevPage: '前のページ',
  nextPage: '次のページ',
  emptySlot: '空きスロット',
  cardPosition: '{number}枠目',
}

const albumCard = (index: number, overrides: Partial<AlbumCard> = {}): AlbumCard => ({
  id: `card-${index}`,
  name: `CardName${index}`,
  image_url: `https://example.com/card-${index}.png`,
  image_padding_color: null,
  isOwned: true,
  ...overrides,
})

const renderAlbum = (cards: AlbumCard[]) =>
  render(
    <CardAlbumView
      cards={cards}
      streamerId="streamer-1"
      translations={albumTranslations}
    />
  )

describe('CardAlbumView - 3x3 固定・画像のみのアルバム表示 (Issue #1765)', () => {
  it('3×3 固定（grid-cols-3 のみ・レスポンシブな列数指定なし）で 9 枠を描く', () => {
    const cards = Array.from({ length: 9 }, (_, i) => albumCard(i + 1))
    renderAlbum(cards)

    const grid = screen.getByTestId('card-album-grid')
    expect(grid.className).toContain('grid-cols-3')
    // 端末幅で列数が変わる指定（sm:/lg:/xl: の grid-cols）を持たないこと
    expect(grid.className).not.toMatch(/(^|\s)(sm|md|lg|xl|2xl):grid-cols-/)
    expect(grid.children).toHaveLength(9)
    // 9枚に収まるためページ送りは出ない
    expect(screen.queryByTestId('card-album-page')).not.toBeInTheDocument()
  })

  it('名前やレアリティの文字を描かず、画像だけを並べる', () => {
    renderAlbum([albumCard(1)])

    // カード名は alt としてのみ存在し、テキストとしては描画されない
    expect(screen.queryByText('CardName1')).not.toBeInTheDocument()
    expect(screen.getByAltText('CardName1')).toBeInTheDocument()
    // レアリティラベル・枚数バッジ・見出しは出ない
    expect(screen.queryAllByRole('heading')).toHaveLength(0)
    expect(screen.queryByText(/x[0-9]+/)).not.toBeInTheDocument()
  })

  it('10枚目以降はページ送りで閲覧でき、最終ページも 3×3 の枠を埋める', () => {
    const cards = Array.from({ length: 10 }, (_, i) => albumCard(i + 1))
    renderAlbum(cards)

    expect(screen.getByTestId('card-album-page')).toHaveTextContent('1 / 2')
    expect(screen.getByTestId('card-album-grid').children).toHaveLength(9)
    expect(screen.getByAltText('CardName1')).toBeInTheDocument()
    expect(screen.queryByAltText('CardName10')).not.toBeInTheDocument()
    // 1ページ目では「前のページ」は押せない
    expect(screen.getByRole('button', { name: '前のページ' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: '次のページ' }))

    expect(screen.getByTestId('card-album-page')).toHaveTextContent('2 / 2')
    expect(screen.getByAltText('CardName10')).toBeInTheDocument()
    expect(screen.queryByAltText('CardName1')).not.toBeInTheDocument()
    // 最終ページも 3×3 の枠数は固定（余りは空きスロット）
    const grid = screen.getByTestId('card-album-grid')
    expect(grid.children).toHaveLength(9)
    expect(screen.getAllByLabelText('空きスロット')).toHaveLength(8)
    expect(screen.getByRole('button', { name: '次のページ' })).toBeDisabled()
  })

  it('未所持カードは画像を出さず空きスロットとして残す（公開モードでも画像は出さない）', () => {
    renderAlbum([
      albumCard(1),
      albumCard(2, { name: 'UnownedCard', isOwned: false }),
    ])

    expect(screen.getByAltText('CardName1')).toBeInTheDocument()
    // 未所持カードの画像・名前はアルバムに出ない
    expect(screen.queryByAltText('UnownedCard')).not.toBeInTheDocument()
    expect(screen.queryByText('UnownedCard')).not.toBeInTheDocument()
    // 2枠目は空きスロット、残り7枠も空きスロット
    expect(screen.getAllByLabelText('空きスロット')).toHaveLength(8)
  })

  it('所持カードのタイルはカード詳細へ遷移できる（並び位置の読み上げラベル付き）', () => {
    renderAlbum([albumCard(1)])

    const link = screen.getByRole('link', { name: '1枠目' })
    expect(link).toHaveAttribute('href', '/collection/streamer-1/card/card-1')
  })
})

const baseCard = (overrides: Partial<Card>): Card => ({
  id: 'card-1',
  streamer_id: 'streamer-1',
  name: 'カードA',
  description: null,
  image_url: 'https://example.com/card-a.png',
  image_padding_color: null,
  rarity: 'common',
  card_number: null,
  max_issuance_count: null,
  collection_name: null,
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

const gridTranslations = {
  cardCountTemplate: 'x{count}',
  noImage: 'NoImage',
  unownedCard: '???',
  unownedStatus: '未所持カード',
  inactiveStatus: 'PAUSED',
  cardNumberTemplate: '#{number}',
  sortLabel: '並び替え',
  sortByNumber: '番号順',
  sortByRarity: 'レアリティ順',
  album: albumTranslations,
}

describe('SortedCardGrid - アルバム表示への切替 (Issue #1765)', () => {
  it('既定はカードグリッドで、アルバムに切り替えるとアルバム表示になる', () => {
    const cards = [
      { ...baseCard({ id: 'card-1', name: 'FirstCard' }), count: 1, isOwned: true, collectionNumber: 1 },
    ]
    render(
      <SortedCardGrid
        cards={cards}
        streamerId="streamer-1"
        translations={gridTranslations}
      />
    )

    // 既定は従来のカードグリッド（名前が見える）
    expect(screen.getByText('FirstCard')).toBeInTheDocument()
    expect(screen.queryByTestId('card-album')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'アルバム' }))

    expect(screen.getByTestId('card-album')).toBeInTheDocument()
    // アルバムではカード名は alt のみ（テキストとしては出ない）
    expect(screen.queryByText('FirstCard')).not.toBeInTheDocument()
    expect(screen.getByAltText('FirstCard')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'カード' }))

    expect(screen.queryByTestId('card-album')).not.toBeInTheDocument()
    expect(screen.getByText('FirstCard')).toBeInTheDocument()
  })
})
