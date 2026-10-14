import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
// - 端末幅で列数が変わらない固定の並び（既定 3×3）
// - 名前・レアリティを出さない画像のみのタイル
// - ページ送りで全カードを閲覧できる
// - 未所持カードは画像を出さず空きスロットとして残す
//
// #1765 フォローアップ:
// - 並び (N×N) を閲覧者がその場で変更できる（3×3 だけでなく 6×6 / 9×9 など）
// - 配信者がコレクション(パック)ごとに指定した既定 N と初期表示モードから始まる

const albumTranslations: AlbumTranslations = {
  viewLabel: '表示',
  gridView: 'カード',
  albumView: 'アルバム',
  gridSizeLabel: '並び',
  gridSizeOption: '{size}×{size}',
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

const renderAlbum = (cards: AlbumCard[], props: Partial<Parameters<typeof CardAlbumView>[0]> = {}) =>
  render(
    <CardAlbumView
      cards={cards}
      streamerId="streamer-1"
      translations={albumTranslations}
      {...props}
    />
  )

const gridStyle = () => screen.getByTestId('card-album-grid').style.gridTemplateColumns

describe('CardAlbumView - 画像のみのアルバム表示 (Issue #1765)', () => {
  it('既定は 3×3（9枠）で、レスポンシブな列数指定を持たない', () => {
    const cards = Array.from({ length: 9 }, (_, i) => albumCard(i + 1))
    renderAlbum(cards)

    const grid = screen.getByTestId('card-album-grid')
    // 列数は inline style で固定する（端末幅で変わる sm:/lg: 等は使わない）
    expect(grid.style.gridTemplateColumns).toBe('repeat(3, minmax(0, 1fr))')
    expect(grid.className).not.toMatch(/(^|\s)(sm|md|lg|xl|2xl):grid-cols-/)
    expect(grid.children).toHaveLength(9)
    // 並びの選択は 3×3 が選ばれている
    expect(screen.getByTestId('card-album-grid-size')).toHaveValue('3')
    // 9枚に収まるためページ送りは出ない
    expect(screen.queryByTestId('card-album-page')).not.toBeInTheDocument()
  })

  it('名前やレアリティの文字を描かず、画像だけを並べる', () => {
    renderAlbum([albumCard(1)])

    // カード名は alt とリンク名に保持し、テキストとしては描画されない
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
    expect(screen.queryByRole('link', { name: /UnownedCard/ })).not.toBeInTheDocument()
    // 2枠目は空きスロット、残り7枠も空きスロット
    expect(screen.getAllByLabelText('空きスロット')).toHaveLength(8)
  })

  it('所持カードのリンク名に位置とカード名を含め、画像なしでもTabでカードを識別できる', async () => {
    renderAlbum([
      albumCard(1),
      albumCard(2, { image_url: null }),
      albumCard(3),
    ])

    const firstLink = screen.getByRole('link', { name: '1枠目: CardName1' })
    const noImageLink = screen.getByRole('link', { name: '2枠目: CardName2' })
    const thirdLink = screen.getByRole('link', { name: '3枠目: CardName3' })

    expect(firstLink).toHaveAttribute('href', '/collection/streamer-1/card/card-1')
    expect(noImageLink).toHaveAttribute('href', '/collection/streamer-1/card/card-2')
    expect(thirdLink).toHaveAttribute('href', '/collection/streamer-1/card/card-3')
    expect(noImageLink.querySelector('img')).not.toBeInTheDocument()
    // タブ順は 並びの選択 → タイル（画像のみでもリンクとして到達できる）
    await userEvent.tab()
    expect(screen.getByTestId('card-album-grid-size')).toHaveFocus()
    await userEvent.tab()
    expect(firstLink).toHaveFocus()
    await userEvent.tab()
    expect(noImageLink).toHaveFocus()
    // 読み上げ名を補っても、画像のみのタイルにカード名の文字は増やさない
    expect(screen.queryByText('CardName1')).not.toBeInTheDocument()
    expect(screen.queryByText('CardName2')).not.toBeInTheDocument()
    expect(screen.queryByText('CardName3')).not.toBeInTheDocument()
  })

  it('2ページ目の所持カードリンク名に通し位置を使う', () => {
    const cards = Array.from({ length: 10 }, (_, i) => albumCard(i + 1))
    renderAlbum(cards)

    fireEvent.click(screen.getByRole('button', { name: '次のページ' }))

    expect(screen.getByRole('link', { name: '10枠目: CardName10' })).toHaveAttribute(
      'href',
      '/collection/streamer-1/card/card-10'
    )
  })
})

describe('CardAlbumView - 並び (N×N) の変更 (#1765 フォローアップ)', () => {
  it('6×6 を選ぶと 36 枠になり、ページ数と列数が追随する', () => {
    const cards = Array.from({ length: 37 }, (_, i) => albumCard(i + 1))
    renderAlbum(cards)

    expect(screen.getByTestId('card-album-page')).toHaveTextContent('1 / 5')

    fireEvent.change(screen.getByTestId('card-album-grid-size'), {
      target: { value: '6' },
    })

    expect(screen.getByTestId('card-album-grid-size')).toHaveValue('6')
    expect(gridStyle()).toBe('repeat(6, minmax(0, 1fr))')
    // 36枚 + 余り1枠 = 37枚で 2/2 ページ（3×3 のときは 1/5）
    expect(screen.getByTestId('card-album-grid').children).toHaveLength(36)
    expect(screen.getByTestId('card-album-page')).toHaveTextContent('1 / 2')
    expect(screen.getByAltText('CardName36')).toBeInTheDocument()
    expect(screen.queryByAltText('CardName37')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '次のページ' }))

    // 最終ページも 36 枠を埋める（余り1枚 + 空き35枠）
    expect(screen.getByTestId('card-album-grid').children).toHaveLength(36)
    expect(screen.getByAltText('CardName37')).toBeInTheDocument()
    expect(screen.getAllByLabelText('空きスロット')).toHaveLength(35)
  })

  it('並びを変えると先頭ページへ戻る', () => {
    const cards = Array.from({ length: 37 }, (_, i) => albumCard(i + 1))
    renderAlbum(cards)

    fireEvent.click(screen.getByRole('button', { name: '次のページ' }))
    expect(screen.getByTestId('card-album-page')).toHaveTextContent('2 / 5')

    fireEvent.change(screen.getByTestId('card-album-grid-size'), {
      target: { value: '9' },
    })

    expect(gridStyle()).toBe('repeat(9, minmax(0, 1fr))')
    // 37枚は 9×9 の1ページに収まるため、ページ送りは出ない
    expect(screen.queryByTestId('card-album-page')).not.toBeInTheDocument()
    expect(screen.getByAltText('CardName1')).toBeInTheDocument()
  })

  it('制御コンポーネントとして渡すと、選択が onGridSizeChange に通知される', () => {
    const onGridSizeChange = vi.fn()
    renderAlbum([albumCard(1)], { gridSize: 6, onGridSizeChange })

    expect(gridStyle()).toBe('repeat(6, minmax(0, 1fr))')

    fireEvent.change(screen.getByTestId('card-album-grid-size'), {
      target: { value: '9' },
    })

    expect(onGridSizeChange).toHaveBeenCalledWith(9)
    // 親が値を更新するまでは渡された値のまま（内部 state では書き換えない）
    expect(gridStyle()).toBe('repeat(6, minmax(0, 1fr))')
  })

  it('選択できる並びは 3..12 の整数のみ（範囲外の値では何も起きない）', () => {
    const onGridSizeChange = vi.fn()
    renderAlbum([albumCard(1)], { gridSize: 3, onGridSizeChange })

    const options = Array.from(
      screen.getByTestId('card-album-grid-size').querySelectorAll('option')
    ).map((option) => option.getAttribute('value'))

    expect(options).toEqual(['3', '4', '5', '6', '7', '8', '9', '10', '11', '12'])

    // 範囲外を直接流しても無視する（select の外から来た値を信用しない）
    fireEvent.change(screen.getByTestId('card-album-grid-size'), {
      target: { value: '99' },
    })
    expect(onGridSizeChange).not.toHaveBeenCalled()
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

const gridCard = (overrides: Partial<Card> = {}) => ({
  ...baseCard({ id: 'card-1', name: 'FirstCard', ...overrides }),
  count: 1,
  isOwned: true,
  collectionNumber: 1,
})

describe('SortedCardGrid - アルバム表示とパック別既定 (#1765)', () => {
  it('既定はカードグリッドで、アルバムに切り替えるとアルバム表示になる', () => {
    render(
      <SortedCardGrid
        cards={[gridCard()]}
        streamerId="streamer-1"
        translations={gridTranslations}
      />
    )

    // 既定は従来のカードグリッド（名前が見える）
    expect(screen.getByText('FirstCard')).toBeInTheDocument()
    expect(screen.queryByTestId('card-album')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'アルバム' }))

    expect(screen.getByTestId('card-album')).toBeInTheDocument()
    // アルバムではカード名は alt とリンク名に保持する（テキストとしては出ない）
    expect(screen.queryByText('FirstCard')).not.toBeInTheDocument()
    expect(screen.getByAltText('FirstCard')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'カード' }))

    expect(screen.queryByTestId('card-album')).not.toBeInTheDocument()
    expect(screen.getByText('FirstCard')).toBeInTheDocument()
  })

  it('配信者の既定（初期表示=アルバム / 並び=6×6）で開く', () => {
    render(
      <SortedCardGrid
        cards={[gridCard()]}
        streamerId="streamer-1"
        translations={gridTranslations}
        albumDefaultView="album"
        albumGridSizes={{ __all__: 6 }}
      />
    )

    expect(screen.getByTestId('card-album')).toBeInTheDocument()
    expect(gridStyle()).toBe('repeat(6, minmax(0, 1fr))')
  })

  it('スコープ（パック）ごとの既定を適用し、スコープが変わると既定へ戻る', () => {
    const cards = [gridCard()]
    const { rerender } = render(
      <SortedCardGrid
        cards={cards}
        streamerId="streamer-1"
        translations={gridTranslations}
        albumDefaultView="album"
        albumGridSizes={{ __all__: 3, weapons: 9, __default__: 6 }}
        albumScopeKey="__all__"
      />
    )

    expect(gridStyle()).toBe('repeat(3, minmax(0, 1fr))')

    // 閲覧者がその場で並びを変えても、同一スコープ内では保持される
    fireEvent.change(screen.getByTestId('card-album-grid-size'), {
      target: { value: '4' },
    })
    expect(gridStyle()).toBe('repeat(4, minmax(0, 1fr))')

    // 別のパックへ切り替えると、そのパックの既定（9×9）になる
    rerender(
      <SortedCardGrid
        cards={cards}
        streamerId="streamer-1"
        translations={gridTranslations}
        albumDefaultView="album"
        albumGridSizes={{ __all__: 3, weapons: 9, __default__: 6 }}
        albumScopeKey="weapons"
      />
    )
    expect(gridStyle()).toBe('repeat(9, minmax(0, 1fr))')

    // 個別指定の無いパックは __all__（3×3）へフォールバックする
    rerender(
      <SortedCardGrid
        cards={cards}
        streamerId="streamer-1"
        translations={gridTranslations}
        albumDefaultView="album"
        albumGridSizes={{ __all__: 3, weapons: 9, __default__: 6 }}
        albumScopeKey="arms"
      />
    )
    expect(gridStyle()).toBe('repeat(3, minmax(0, 1fr))')
  })
})
