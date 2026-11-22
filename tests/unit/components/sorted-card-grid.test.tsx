import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import SortedCardGrid from '@/components/SortedCardGrid'
import type { Card } from '@/types/database'

// ExpandableDescription が useTranslations（next-intl）を使うようになったため（#835）、
// Provider なしのテストでもキー解決が動くよう next-intl をモックする。
// このテストの対象（SortedCardGrid）は translations を props で受けるため、
// モックは ExpandableDescription の「開く/閉じる」だけ解決できれば十分。
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = { expand: '開く', collapse: '閉じる' }
    return map[key] ?? key
  },
}))

// Issue #395 / #2070 フォローアップ: 未所持カードの名前・画像・説明を項目別に
// マスクする表示を検証する。非公開項目はプレースホルダー（名前は unownedCard の
// 「？？？」、画像は noImageText、説明は非表示）になる。所持カードは常に
// 全項目を本来の値で表示する。
//
// Per-item masking: private unowned items render placeholders; owned cards always
// render their actual name/image/description regardless of the flags.

const baseCard = (overrides: Partial<Card>): Card => ({
  id: 'card-1',
  streamer_id: 'streamer-1',
  name: 'カードA',
  description: 'カードAの説明',
  image_url: 'https://example.com/card-a.png',
  image_padding_color: null,
  rarity: 'common',
  card_number: null,
  // Card.max_issuance_count は `number | null`(undefined 非許容)。overrides のみに
  // 委ねると Partial<Card> 由来で `undefined` を許容してしまい型不一致になるため、
  // ベースオブジェクト側で明示的にデフォルト値を持たせる。
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

const ALL_VISIBLE = { name: true, image: true, description: true }
const ALL_HIDDEN = { name: false, image: false, description: false }

const baseTranslations = {
  cardCountTemplate: 'x{count}',
  noImage: 'NoImage',
  unownedCard: '???',
  unownedStatus: '未所持カード',
  inactiveStatus: 'PAUSED',
  cardNumberTemplate: '#{number}',
  sortLabel: '並び替え',
  sortByNumber: '番号順',
  sortByRarity: 'レアリティ順',
  // Issue #1765: アルバム表示（画像のみ・N×N）の翻訳
  album: {
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
  },
}

describe('SortedCardGrid - unowned card visibility (Issue #395)', () => {
  it('renders encyclopedia numbers and defaults to number order', () => {
    const cards = [
      { ...baseCard({ id: 'card-2', name: 'SecondCard', created_at: '2026-04-02T00:00:00Z' }), count: 1, isOwned: true, collectionNumber: 2 },
      { ...baseCard({ id: 'card-1', name: 'FirstCard', created_at: '2026-04-01T00:00:00Z' }), count: 1, isOwned: true, collectionNumber: 1 },
    ]
    render(
      <SortedCardGrid
        cards={cards}
        streamerId="streamer-1"
        translations={baseTranslations}
      />
    )

    expect(screen.getByText('#1')).toBeInTheDocument()
    expect(screen.getByText('#2')).toBeInTheDocument()
    const names = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)
    expect(names).toEqual(['FirstCard', 'SecondCard'])
  })

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
    expect(screen.getByAltText('OwnedCard')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'OwnedCard: x2' })).toBeInTheDocument()
  })

  it('reveals name/image/description for unowned cards when all items are public (公開モード)', () => {
    // show_unowned_cards=true かつ新3列がすべて true の経路。
    // i18n ラベル「画像・説明を公開」の契約どおり、未所持カードでも本来の name / image_url
    // / description が表示される必要がある（所持カードとの差はロックアイコンと所有数の非表示のみ）。
    // The "reveal details" mode contract: name, image, and description must be visible
    // even for unowned cards; only ownership-specific UI (count, lock styling) differs.
    const cards = [
      {
        ...baseCard({
          id: 'unowned-1',
          name: 'SecretCard',
          description: 'カード説明テキスト',
        }),
        count: 0,
        isOwned: false,
      },
    ]
    render(
      <SortedCardGrid
        cards={cards}
        streamerId="streamer-1"
        unownedCardVisibility={ALL_VISIBLE}
        translations={baseTranslations}
      />
    )
    // 名前は本来のものが見える
    expect(screen.getByText('SecretCard')).toBeInTheDocument()
    // 画像も描画される（alt は本来の名前）
    expect(screen.getByAltText('SecretCard')).toBeInTheDocument()
    // 説明テキストも見える
    expect(screen.getByText(/カード説明テキスト/)).toBeInTheDocument()
    expect(screen.getByText('未所持カード')).toBeInTheDocument()
    // 公開モードでも未所持カードは詳細遷移を提供しない
    // Unowned public cards reveal content but remain non-navigable.
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('keeps disclosure controls outside detail links and operable for owned and unowned cards', () => {
    const proto = HTMLElement.prototype
    const savedScrollHeight = Object.getOwnPropertyDescriptor(proto, 'scrollHeight')
    const savedClientHeight = Object.getOwnPropertyDescriptor(proto, 'clientHeight')
    Object.defineProperty(proto, 'scrollHeight', { configurable: true, value: 100 })
    Object.defineProperty(proto, 'clientHeight', { configurable: true, value: 50 })

    try {
      const cards = [
        {
          ...baseCard({ id: 'owned-long', name: 'OwnedLong', description: '長い説明1' }),
          count: 1,
          isOwned: true,
        },
        {
          ...baseCard({ id: 'unowned-long', name: 'UnownedLong', description: '長い説明2' }),
          count: 0,
          isOwned: false,
        },
      ]
      render(
        <SortedCardGrid
          cards={cards}
          streamerId="streamer-1"
          unownedCardVisibility={ALL_VISIBLE}
          translations={baseTranslations}
        />
      )

      const buttons = screen.getAllByRole('button', { name: '開く' })
      expect(buttons).toHaveLength(2)
      for (const button of buttons) {
        expect(button.closest('a')).toBeNull()
        expect(button.closest('[aria-disabled="true"]')).toBeNull()
        button.focus()
        fireEvent.click(button)
        expect(button).toHaveAttribute('aria-expanded', 'true')
      }
    } finally {
      if (savedScrollHeight) {
        Object.defineProperty(proto, 'scrollHeight', savedScrollHeight)
      } else {
        delete (proto as unknown as Record<string, unknown>).scrollHeight
      }
      if (savedClientHeight) {
        Object.defineProperty(proto, 'clientHeight', savedClientHeight)
      } else {
        delete (proto as unknown as Record<string, unknown>).clientHeight
      }
    }
  })

  it('hides unowned card image / name / description when all items are private (placeholder only)', () => {
    const cards = [
      {
        ...baseCard({
          id: 'unowned-1',
          name: 'SecretCard',
          description: 'カード説明テキスト',
        }),
        count: 0,
        isOwned: false,
      },
    ]
    render(
      <SortedCardGrid
        cards={cards}
        streamerId="streamer-1"
        unownedCardVisibility={ALL_HIDDEN}
        translations={baseTranslations}
      />
    )
    // 名前は隠される
    expect(screen.queryByText('SecretCard')).not.toBeInTheDocument()
    // 画像領域は noImageText (= unownedCard) のプレースホルダーになる
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    // 説明テキストは漏れない
    expect(screen.queryByText(/カード説明テキスト/)).not.toBeInTheDocument()
    // "???" は名前とプレースホルダーの両方で出るため、複数あって良い
    expect(screen.getAllByText('???').length).toBeGreaterThan(0)
  })

  /**
   * Issue #2070 フォローアップ: 項目別の組合せで、公開した項目だけが本来の値で
   * 表示され、非公開項目はプレースホルダーになることを固定する。
   * （RSC ペイロードからの実値除去は collection page 側のテストが担う）
   */
  it.each([
    { visibility: { name: true, image: false, description: false }, label: '名前のみ' },
    { visibility: { name: false, image: true, description: false }, label: '画像のみ' },
    { visibility: { name: false, image: false, description: true }, label: '説明のみ' },
    { visibility: { name: true, image: true, description: false }, label: '名前+画像' },
    { visibility: { name: true, image: false, description: true }, label: '名前+説明' },
    { visibility: { name: false, image: true, description: true }, label: '画像+説明' },
  ])('項目別マスク($label)で公開項目だけを表示する', ({ visibility }) => {
    const cards = [
      {
        ...baseCard({
          id: 'unowned-1',
          name: 'SecretCard',
          description: 'カード説明テキスト',
        }),
        count: 0,
        isOwned: false,
      },
    ]
    render(
      <SortedCardGrid
        cards={cards}
        streamerId="streamer-1"
        unownedCardVisibility={visibility}
        translations={baseTranslations}
      />
    )

    if (visibility.name) {
      expect(screen.getByText('SecretCard')).toBeInTheDocument()
    } else {
      expect(screen.queryByText('SecretCard')).not.toBeInTheDocument()
      // 名前のプレースホルダーは既存の unownedCard（「？？？」）。
      expect(screen.getAllByText('???').length).toBeGreaterThan(0)
    }

    if (visibility.image) {
      // 名前が非公開でも alt は表示名（「？？？」）になり、実名は漏れない。
      const img = screen.getByRole('img')
      expect(img).toHaveAttribute(
        'alt',
        visibility.name ? 'SecretCard' : '???',
      )
    } else {
      expect(screen.queryByRole('img')).not.toBeInTheDocument()
    }

    if (visibility.description) {
      expect(screen.getByText(/カード説明テキスト/)).toBeInTheDocument()
    } else {
      expect(screen.queryByText(/カード説明テキスト/)).not.toBeInTheDocument()
    }

    // レアリティと表示番号は常に公開。
    expect(screen.getByText('コモン')).toBeInTheDocument()
  })

  it('always shows the rarity badge regardless of unowned item visibility (Issue #395 core requirement)', () => {
    // Issue 本文の「⑤???」ように、レアリティ（または序列）は常に視聴者に出すのが要点。
    // The rarity badge must always be visible — that is what makes "placeholder mode"
    // useful at all (otherwise the placeholder would carry zero information).
    const cards = [
      { ...baseCard({ id: 'unowned-1', name: 'SecretCard', rarity: 'legendary' }), count: 0, isOwned: false },
    ]
    render(
      <SortedCardGrid
        cards={cards}
        streamerId="streamer-1"
        unownedCardVisibility={ALL_HIDDEN}
        translations={baseTranslations}
      />
    )
    // RARITIES のラベルは constants.ts に定義されている (legendary → "レジェンダリー")
    // The rarity label comes from RARITIES constants, not i18n.
    expect(screen.getByText("レジェンダリー")).toBeInTheDocument()
  })

  it('still shows owned card details even when all unowned items are private', () => {
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
        unownedCardVisibility={ALL_HIDDEN}
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
