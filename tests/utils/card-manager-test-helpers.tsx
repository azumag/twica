import { render } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import CardManager from '@/components/CardManager'
import jaMessages from '../../messages/ja.json'
import type { Card } from '@/types/database'

// CardManager のテスト用共通ヘルパー。card-manager-search.test.tsx /
// card-manager-pack-filter.test.tsx / card-manager-card-packs.test.tsx の
// 3ファイルが同一の baseCard / renderCardManager をコピペしていたため集約した。
// renderCardManager は props を上書きできるスーパーセット版（各ファイルの
// 呼び出し方をすべてそのままカバーする）。vi.mock('@/lib/logger') はファイル
// ごとに hoisting されるため、利用側の各テストファイルで個別に呼び出すこと。

export const baseCard = (overrides: Partial<Card>): Card => ({
  id: 'card-1',
  streamer_id: 'streamer-1',
  name: 'カードA',
  description: '',
  image_url: null,
  rarity: 'common',
  card_number: null,
  max_issuance_count: null,
  collection_name: null,
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

export const renderCardManager = (
  cards: Card[],
  props: Partial<React.ComponentProps<typeof CardManager>> = {}
) => {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <CardManager
        streamerId="streamer-1"
        initialCards={cards}
        initialRarityWeights={{}}
        {...props}
      />
    </NextIntlClientProvider>
  )
}
