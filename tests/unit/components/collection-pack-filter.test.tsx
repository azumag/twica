import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import CollectionPackFilter from '@/components/CollectionPackFilter'
import type { CollectionPackDisplay } from '@/components/CollectionPackFilter'
import type { StreamerCollectionCard } from '@/components/StreamerCollection'
import { DEFAULT_PACK_SENTINEL } from '@/lib/validation/collection-name'
import jaMessages from '../../../messages/ja.json'

// Issue #557: コレクションページのパック絞り込みUI。
// - 初期状態は「すべて」（全カード + 全体進捗、従来表示と同一入力）
// - パック選択でそのパックのカードのみ + パック内進捗/コンプリート表示
// - デフォルトパックは sentinel キーで未分類カードに絞り込む

const baseCard = (overrides: Partial<StreamerCollectionCard>): StreamerCollectionCard => ({
  id: 'card-1',
  streamer_id: 'streamer-1',
  name: 'カードA',
  description: '',
  image_url: null,
  image_padding_color: null,
  rarity: 'common',
  card_number: null,
  // StreamerCollectionCard.max_issuance_count は `number | null`(undefined 非許容)。
  // overrides のみに委ねると Partial<> 由来で `undefined` を許容してしまい型不一致に
  // なるため、ベースオブジェクト側で明示的にデフォルト値を持たせる。
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
  count: 1,
  isOwned: true,
  ...overrides,
})

const gridTranslations = {
  cardCountTemplate: 'x{count}',
  noImage: 'NoImage',
  unownedCard: '???',
  inactiveStatus: 'PAUSED',
  cardNumberTemplate: '#{number}',
  sortLabel: '並び替え',
  sortByNumber: '番号順',
  sortByRarity: 'レアリティ順',
}

const cards: StreamerCollectionCard[] = [
  baseCard({ id: 'w1', name: 'WeaponCard', collection_name: 'weapons' }),
  baseCard({ id: 'u1', name: 'UnclassifiedCard', collection_name: null }),
]

const packs: CollectionPackDisplay[] = [
  {
    key: DEFAULT_PACK_SENTINEL,
    displayName: null,
    progress: { owned: 1, total: 2 },
    completionHistory: [],
  },
  {
    key: 'weapons',
    displayName: 'weapons',
    progress: { owned: 1, total: 1 },
    completionHistory: [{ total_cards: 1, completed_at: '2026-06-01T00:00:00Z' }],
  },
  {
    key: 'characters',
    displayName: 'characters',
    progress: { owned: 0, total: 2 },
    completionHistory: [],
  },
]

const renderFilter = (overrides: Partial<React.ComponentProps<typeof CollectionPackFilter>> = {}) =>
  render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <CollectionPackFilter
        cards={cards}
        streamerId="streamer-1"
        hideUnownedDetails={false}
        overallProgress={{ owned: 2, total: 5 }}
        overallCompletionHistory={[]}
        packs={packs}
        gridTranslations={gridTranslations}
        {...overrides}
      />
    </NextIntlClientProvider>
  )

describe('CollectionPackFilter', () => {
  it('defaults to "すべて" (all cards + overall progress)', () => {
    renderFilter()

    const allButton = screen.getByRole('button', { name: 'すべて' })
    expect(allButton).toHaveAttribute('aria-pressed', 'true')
    // 全カードが表示される
    expect(screen.getByText('WeaponCard')).toBeInTheDocument()
    expect(screen.getByText('UnclassifiedCard')).toBeInTheDocument()
    // 全体進捗が表示される
    expect(screen.getByText('2/5種類')).toBeInTheDocument()
  })

  it('filters to the selected pack and shows its progress + completion state', () => {
    renderFilter()

    fireEvent.click(screen.getByRole('button', { name: 'weapons' }))

    // 絞り込み: weapons のカードのみ
    expect(screen.getByText('WeaponCard')).toBeInTheDocument()
    expect(screen.queryByText('UnclassifiedCard')).not.toBeInTheDocument()
    // パック内進捗 + コンプリート表示 + 達成日時
    expect(screen.getByText('1/1種類')).toBeInTheDocument()
    expect(screen.getByText('コンプリート！')).toBeInTheDocument()
    expect(screen.getByText(/達成日時/)).toBeInTheDocument()
  })

  it('filters unclassified cards via the default pseudo-pack (sentinel key) with the generic label', () => {
    renderFilter()

    // displayName null → 汎用ラベル「デフォルト」
    fireEvent.click(screen.getByRole('button', { name: 'デフォルト' }))

    expect(screen.getByText('UnclassifiedCard')).toBeInTheDocument()
    expect(screen.queryByText('WeaponCard')).not.toBeInTheDocument()
    expect(screen.getByText('1/2種類')).toBeInTheDocument()
    expect(screen.queryByText('コンプリート！')).not.toBeInTheDocument()
  })

  it('shows the streamer-defined default pack name when set', () => {
    renderFilter({
      packs: [{ ...packs[0], displayName: 'オリジナルカード' }, ...packs.slice(1)],
    })

    expect(screen.getByRole('button', { name: 'オリジナルカード' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'デフォルト' })).not.toBeInTheDocument()
  })

  it('shows the empty-pack message (not the legacy CTA) when the selected pack has no visible cards', () => {
    renderFilter()

    // characters パックのカードは cards に1枚も無い（未所持カード非公開ケース）
    fireEvent.click(screen.getByRole('button', { name: 'characters' }))

    expect(screen.getByText('このパックのカードはまだ持っていません。')).toBeInTheDocument()
    expect(screen.queryByText('WeaponCard')).not.toBeInTheDocument()
    // パック文脈では従来の全体向け空表示 (empty.line1) は出さない
    expect(
      screen.queryByText(/この配信者のカードはまだ持っていません。/)
    ).not.toBeInTheDocument()
  })

  it('shows the legacy CTA empty message (not emptyPack) on the "すべて" tab when the viewer has no visible cards', () => {
    // 到達条件: 名前付きパックあり配信者 × 所持0枚の視聴者 ×
    // show_unowned_cards=false → cards が空のままフィルタが描画される。
    // 従来 (packs 無し分岐) と同じ empty.line1/line2 の CTA 付き2行を出すこと。
    renderFilter({ cards: [] })

    expect(
      screen.getByText(/この配信者のカードはまだ持っていません。/)
    ).toBeInTheDocument()
    expect(
      screen.getByText(/チャネルポイントを使ってカードをゲットしましょう！/)
    ).toBeInTheDocument()
    expect(
      screen.queryByText('このパックのカードはまだ持っていません。')
    ).not.toBeInTheDocument()
  })

  it('returns to the unfiltered view when "すべて" is re-selected', () => {
    renderFilter()

    fireEvent.click(screen.getByRole('button', { name: 'weapons' }))
    fireEvent.click(screen.getByRole('button', { name: 'すべて' }))

    expect(screen.getByText('WeaponCard')).toBeInTheDocument()
    expect(screen.getByText('UnclassifiedCard')).toBeInTheDocument()
    expect(screen.getByText('2/5種類')).toBeInTheDocument()
  })
})
