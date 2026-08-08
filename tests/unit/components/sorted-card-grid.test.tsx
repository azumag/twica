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

  it('reveals name/image/description for unowned cards when hideUnownedDetails=false (公開モード)', () => {
    // show_unowned_card_details=true → hideUnownedDetails=false の経路。
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
        hideUnownedDetails={false}
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
          hideUnownedDetails={false}
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

  it('hides unowned card image / name / description when hideUnownedDetails=true (placeholder only)', () => {
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
        hideUnownedDetails
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

  it('always shows the rarity badge regardless of hideUnownedDetails (Issue #395 core requirement)', () => {
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
        hideUnownedDetails
        translations={baseTranslations}
      />
    )
    // RARITIES のラベルは constants.ts に定義されている (legendary → "レジェンダリー")
    // The rarity label comes from RARITIES constants, not i18n.
    expect(screen.getByText("レジェンダリー")).toBeInTheDocument()
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
