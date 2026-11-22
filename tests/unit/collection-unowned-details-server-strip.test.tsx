import { beforeEach, it, expect, vi } from 'vitest';
import type { CompletionRewardView } from '@/lib/pack-completion-reward';

// Issue #1748 / #2070 フォローアップ:
// 未所持カードの name / image_url / description は項目別の公開設定に従い、
// 非公開の実値をサーバー側で落としてから client component へ渡すこと
// （RSC ペイロード経由の漏えい防止）。
// クライアント側のマスク表示テストは sorted-card-grid.test.tsx が担う。
const cfg = vi.hoisted(() => ({
  show_unowned_cards: true,
  show_unowned_card_details: false as boolean | null | undefined,
  show_unowned_card_name: undefined as boolean | null | undefined,
  show_unowned_card_image: undefined as boolean | null | undefined,
  show_unowned_card_description: undefined as boolean | null | undefined,
  rewardCount: 0,
  rewardState: 'granted' as CompletionRewardView['state'],
}));
const fixtures = vi.hoisted(() => ({
  owned: {
    id: 'owned-1', name: 'OwnedCard', description: '所持の説明',
    image_url: 'https://example.com/owned.png', rarity: 'common',
    card_number: 1, collection_name: null, is_active: true,
    created_at: '2026-01-01T00:00:00Z', count: 1,
  },
  unowned: {
    id: 'unowned-1', name: 'SecretCard', description: '秘密の説明',
    image_url: 'https://example.com/secret.png', rarity: 'legendary',
    card_number: 2, collection_name: null, is_active: true,
    created_at: '2026-01-02T00:00:00Z',
  },
  historicalReward: {
    id: 'historical-reward', name: 'HistoricalSecretReward',
    description: 'Historical secret reward description',
    image_url: 'https://example.com/historical-secret-reward.png', rarity: 'rare',
    card_number: 3, collection_name: null, is_active: false,
    created_at: '2026-01-03T00:00:00Z',
  },
}));
vi.mock('@/lib/session', () => ({ getSession: async () => ({ twitchUserId: 'viewer' }) }));
vi.mock('@/lib/dashboard-data', () => ({
  getStreamerById: async () => ({
    id: 'streamer', card_pack_names: [], default_card_pack_name: null,
    show_unowned_cards: cfg.show_unowned_cards,
    show_unowned_card_details: cfg.show_unowned_card_details,
    show_unowned_card_name: cfg.show_unowned_card_name,
    show_unowned_card_image: cfg.show_unowned_card_image,
    show_unowned_card_description: cfg.show_unowned_card_description,
  }),
  getUserCardsForStreamer: async () => [fixtures.owned],
  getActiveCardsForStreamer: async () => [fixtures.owned, fixtures.unowned],
  getCollectionCompletions: async () => [],
  recordCollectionCompletion: vi.fn(), recordPackCompletion: vi.fn(),
}));
vi.mock('@/lib/services/pack-completion-reward', () => ({
  applyPackCompletionRewards: async (_userId: string, _streamerId: string, _active: unknown, cards: unknown[]) => ({
    // The service keeps a full historical view after trading/consumption, but
    // includes the historical card in its ownership list only with >0 copies.
    views: cfg.rewardState === 'locked'
      ? [{ collectionName: '__default__', state: 'locked', rarity: fixtures.historicalReward.rarity }]
      : [{ collectionName: '__default__', state: cfg.rewardState, card: fixtures.historicalReward }],
    cards: cfg.rewardCount > 0
      ? [...cards, { ...fixtures.historicalReward, count: cfg.rewardCount }]
      : cards,
    rewardCardIds: cfg.rewardState === 'locked' ? [] : [fixtures.historicalReward.id],
  }),
}));
vi.mock('@/components/StreamerCollection', () => ({ default: () => null }));
import Page from '@/app/collection/[streamerId]/page';

type CardProp = {
  id: string;
  name: string;
  image_url: string | null;
  description: string | null;
  isOwned: boolean;
  rarity: string;
  card_number: number | null;
};
type Visibility = { name: boolean; image: boolean; description: boolean };

beforeEach(() => {
  cfg.show_unowned_cards = true;
  cfg.show_unowned_card_details = false;
  cfg.show_unowned_card_name = undefined;
  cfg.show_unowned_card_image = undefined;
  cfg.show_unowned_card_description = undefined;
  cfg.rewardCount = 0;
  cfg.rewardState = 'granted';
});

function unownedCard(props: { cards: CardProp[] }): CardProp | undefined {
  return props.cards.find((c) => c.id === 'unowned-1');
}

it('strips unowned card details server-side when details are hidden (Issue #1748)', async () => {
  cfg.show_unowned_cards = true;
  cfg.show_unowned_card_details = false;
  const element = await Page({ params: Promise.resolve({ streamerId: 'streamer' }) });
  const cards = element.props.cards as CardProp[];
  expect(cards).toHaveLength(2);
  const unowned = unownedCard({ cards });
  expect(unowned?.isOwned).toBe(false);
  // RSC ペイロードに実データが含まれないこと
  expect(unowned?.name).toBe('');
  expect(unowned?.image_url).toBeNull();
  expect(unowned?.description).toBeNull();
  // 所持カードは影響を受けない
  const owned = cards.find((c) => c.id === 'owned-1');
  expect(owned?.name).toBe('OwnedCard');
  expect(owned?.image_url).toBe('https://example.com/owned.png');
  expect(element.props.unownedCardVisibility).toEqual({ name: false, image: false, description: false });
});

it('keeps unowned card details in public mode (show_unowned_card_details=true)', async () => {
  cfg.show_unowned_cards = true;
  cfg.show_unowned_card_details = true;
  const element = await Page({ params: Promise.resolve({ streamerId: 'streamer' }) });
  const cards = element.props.cards as CardProp[];
  const unowned = unownedCard({ cards });
  expect(unowned?.name).toBe('SecretCard');
  expect(unowned?.image_url).toBe('https://example.com/secret.png');
  expect(unowned?.description).toBe('秘密の説明');
  expect(element.props.unownedCardVisibility).toEqual({ name: true, image: true, description: true });
});

/**
 * Issue #2070 フォローアップ: 項目別の組合せごとに、非公開項目の実値だけが
 * RSC ペイロードから落ちることを固定する。details は C4 のミラー
 * （name && image && description）を再現し、部分公開が旧列の false で
 * 潰されないことも同時に確認する。
 */
const itemCombinations: Array<{ label: string; visibility: Visibility }> = [
  { label: '全部非公開', visibility: { name: false, image: false, description: false } },
  { label: '名前のみ', visibility: { name: true, image: false, description: false } },
  { label: '画像のみ', visibility: { name: false, image: true, description: false } },
  { label: '説明のみ', visibility: { name: false, image: false, description: true } },
  { label: '名前+画像', visibility: { name: true, image: true, description: false } },
  { label: '名前+説明', visibility: { name: true, image: false, description: true } },
  { label: '画像+説明', visibility: { name: false, image: true, description: true } },
  { label: '全部公開', visibility: { name: true, image: true, description: true } },
];

it.each(itemCombinations)(
  '項目別の組合せ($label)で非公開項目の実値だけを落とす',
  async ({ visibility }) => {
    cfg.show_unowned_cards = true;
    cfg.show_unowned_card_details =
      visibility.name && visibility.image && visibility.description;
    cfg.show_unowned_card_name = visibility.name;
    cfg.show_unowned_card_image = visibility.image;
    cfg.show_unowned_card_description = visibility.description;

    const element = await Page({ params: Promise.resolve({ streamerId: 'streamer' }) });
    const cards = element.props.cards as CardProp[];
    const unowned = unownedCard({ cards });

    expect(element.props.unownedCardVisibility).toEqual(visibility);
    expect(unowned?.name).toBe(visibility.name ? fixtures.unowned.name : '');
    expect(unowned?.image_url).toBe(visibility.image ? fixtures.unowned.image_url : null);
    expect(unowned?.description).toBe(
      visibility.description ? fixtures.unowned.description : null,
    );

    // JSON 全体でも非公開項目の実値が存在しないこと（別フィールドへの混入防止）。
    const serialized = JSON.stringify(cards);
    if (!visibility.name) expect(serialized).not.toContain(fixtures.unowned.name);
    if (!visibility.image) expect(serialized).not.toContain(fixtures.unowned.image_url);
    if (!visibility.description) expect(serialized).not.toContain(fixtures.unowned.description);
    if (visibility.name) expect(serialized).toContain(fixtures.unowned.name);
    if (visibility.image) expect(serialized).toContain(fixtures.unowned.image_url);
    if (visibility.description) expect(serialized).toContain(fixtures.unowned.description);

    // レアリティと表示番号は常に公開。
    expect(unowned?.rarity).toBe('legendary');
    expect(unowned?.card_number).toBe(2);
  },
);

it('旧アプリで details を OFF にした取りこぼし（新3列が全 true）は全項目非公開に倒す', async () => {
  cfg.show_unowned_cards = true;
  cfg.show_unowned_card_details = false;
  cfg.show_unowned_card_name = true;
  cfg.show_unowned_card_image = true;
  cfg.show_unowned_card_description = true;

  const element = await Page({ params: Promise.resolve({ streamerId: 'streamer' }) });
  const unowned = unownedCard({ cards: element.props.cards as CardProp[] });

  expect(element.props.unownedCardVisibility).toEqual({ name: false, image: false, description: false });
  expect(unowned?.name).toBe('');
  expect(unowned?.image_url).toBeNull();
  expect(unowned?.description).toBeNull();
});

it('デプロイ窓（新3列が undefined）は旧 details から導出する', async () => {
  cfg.show_unowned_cards = true;
  cfg.show_unowned_card_details = true;
  cfg.show_unowned_card_name = undefined;
  cfg.show_unowned_card_image = undefined;
  cfg.show_unowned_card_description = undefined;

  const element = await Page({ params: Promise.resolve({ streamerId: 'streamer' }) });
  const unowned = unownedCard({ cards: element.props.cards as CardProp[] });

  expect(element.props.unownedCardVisibility).toEqual({ name: true, image: true, description: true });
  expect(unowned?.name).toBe('SecretCard');
  expect(unowned?.image_url).toBe('https://example.com/secret.png');
  expect(unowned?.description).toBe('秘密の説明');
});

const visibilitySettings = [
  { showCards: false, showDetails: false },
  { showCards: false, showDetails: true },
  { showCards: true, showDetails: false },
  { showCards: true, showDetails: true },
];

it.each(visibilitySettings)('protects zero-owned historical rewards with $showCards/$showDetails', async ({ showCards, showDetails }) => {
  cfg.show_unowned_cards = showCards;
  cfg.show_unowned_card_details = showDetails;
  const element = await Page({ params: Promise.resolve({ streamerId: 'streamer' }) });
  const serialized = JSON.stringify(element.props);
  if (showCards && showDetails) {
    expect(element.props.completionRewards).toEqual([
      { collectionName: '__default__', state: 'granted', card: fixtures.historicalReward },
    ]);
    expect(serialized).toContain(fixtures.historicalReward.name);
  } else {
    expect(element.props.completionRewards).toEqual([]);
    for (const value of [fixtures.historicalReward.name, fixtures.historicalReward.image_url, fixtures.historicalReward.description]) {
      expect(serialized).not.toContain(value);
    }
  }
});

it.each(itemCombinations)(
  '完了報酬は3項目すべて公開($label)のときだけ未所持報酬を載せる',
  async ({ visibility }) => {
    cfg.show_unowned_cards = true;
    cfg.show_unowned_card_details =
      visibility.name && visibility.image && visibility.description;
    cfg.show_unowned_card_name = visibility.name;
    cfg.show_unowned_card_image = visibility.image;
    cfg.show_unowned_card_description = visibility.description;

    const element = await Page({ params: Promise.resolve({ streamerId: 'streamer' }) });
    const allVisible =
      visibility.name && visibility.image && visibility.description;
    const serialized = JSON.stringify(element.props.completionRewards);
    if (allVisible) {
      expect(element.props.completionRewards).toHaveLength(1);
      expect(serialized).toContain(fixtures.historicalReward.name);
    } else {
      // 部分公開のカードを報酬一覧に出すと、非公開項目の実値が報酬
      // オブジェクト経由で RSC ペイロードに載るため、既存挙動どおり落とす。
      expect(element.props.completionRewards).toEqual([]);
      expect(serialized).not.toContain(fixtures.historicalReward.name);
      expect(serialized).not.toContain(fixtures.historicalReward.image_url);
      expect(serialized).not.toContain(fixtures.historicalReward.description);
    }
  },
);

it.each(visibilitySettings)('preserves owned reward details with $showCards/$showDetails', async ({ showCards, showDetails }) => {
  cfg.show_unowned_cards = showCards;
  cfg.show_unowned_card_details = showDetails;
  cfg.rewardCount = 1;
  for (const state of ['granted', 'grantedNow'] as const) {
    cfg.rewardState = state;
    const element = await Page({ params: Promise.resolve({ streamerId: 'streamer' }) });
    expect(element.props.completionRewards).toEqual([
      { collectionName: '__default__', state, card: fixtures.historicalReward },
    ]);
    const card = element.props.cards.find((c: CardProp) => c.id === fixtures.historicalReward.id);
    expect(card).toMatchObject({ name: fixtures.historicalReward.name, isOwned: true, isCompletionReward: true, count: 1 });
  }
});

it.each(visibilitySettings)('keeps locked reward views free of secret details with $showCards/$showDetails', async ({ showCards, showDetails }) => {
  cfg.show_unowned_cards = showCards;
  cfg.show_unowned_card_details = showDetails;
  cfg.rewardState = 'locked';
  const element = await Page({ params: Promise.resolve({ streamerId: 'streamer' }) });
  expect(element.props.completionRewards).toEqual([
    { collectionName: '__default__', state: 'locked', rarity: fixtures.historicalReward.rarity },
  ]);
  const serialized = JSON.stringify(element.props);
  for (const value of [fixtures.historicalReward.name, fixtures.historicalReward.image_url, fixtures.historicalReward.description]) {
    expect(serialized).not.toContain(value);
  }
});
