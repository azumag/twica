import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import StreamerCollection from '@/components/StreamerCollection'
import { DEFAULT_PACK_SENTINEL } from '@/lib/validation/collection-name'
import type { Streamer } from '@/types/database'

// Issue #557: StreamerCollection のパックフィルタ表示分岐。
// packs が空（名前付きパック未使用の配信者）→ フィルタUIを出さず従来表示、
// packs あり → CollectionPackFilter に置き換わる（進捗/グリッドはその内部）。
//
// StreamerCollection は async Server Component のため、await して得た JSX を
// そのまま render する。子コンポーネントは表示分岐の検証に十分なスタブに
// 置き換える（フィルタ内部の挙動は collection-pack-filter.test.tsx が担当）。

vi.mock('next-intl/server', () => ({
  // キーをそのまま返す t 関数（分岐の構造検証に翻訳内容は不要）
  getTranslations: async () => (key: string) => key,
}))

vi.mock('@/components/Stats', () => ({
  default: () => <div data-testid="stats" />,
}))
vi.mock('@/components/CollectionProgress', () => ({
  default: () => <div data-testid="collection-progress" />,
}))
vi.mock('@/components/SortedCardGrid', () => ({
  default: () => <div data-testid="sorted-card-grid" />,
}))
vi.mock('@/components/CollectionPackFilter', () => ({
  default: () => <div data-testid="pack-filter" />,
}))

const streamer = {
  id: 'streamer-1',
  twitch_display_name: 'TestStreamer',
  twitch_profile_image_url: null,
} as unknown as Streamer

const baseProps = {
  streamer,
  cards: [],
  stats: { total: 0, unique: 0, legendary: 0, epic: 0, rare: 0, common: 0 },
  progress: { owned: 0, total: 0 },
  visibleCardTypes: 0,
}

describe('StreamerCollection pack filter visibility (Issue #557)', () => {
  it('renders the legacy layout (no filter UI) when packs is empty', async () => {
    render(await StreamerCollection({ ...baseProps, packs: [] }))

    expect(screen.queryByTestId('pack-filter')).not.toBeInTheDocument()
    expect(screen.getByTestId('collection-progress')).toBeInTheDocument()
  })

  it('renders the legacy layout when packs is omitted (default)', async () => {
    render(await StreamerCollection(baseProps))

    expect(screen.queryByTestId('pack-filter')).not.toBeInTheDocument()
    expect(screen.getByTestId('collection-progress')).toBeInTheDocument()
  })

  it('renders the pack filter (which owns progress + grid) when packs are provided', async () => {
    render(
      await StreamerCollection({
        ...baseProps,
        packs: [
          {
            key: DEFAULT_PACK_SENTINEL,
            displayName: null,
            progress: { owned: 0, total: 1 },
            completionHistory: [],
          },
          {
            key: 'weapons',
            displayName: 'weapons',
            progress: { owned: 0, total: 1 },
            completionHistory: [],
          },
        ],
      })
    )

    expect(screen.getByTestId('pack-filter')).toBeInTheDocument()
    // 従来のトップレベル進捗/グリッドはフィルタ内部に置き換わる
    expect(screen.queryByTestId('collection-progress')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sorted-card-grid')).not.toBeInTheDocument()
  })
})
