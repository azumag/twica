import { beforeEach, it, expect, vi } from 'vitest';
import type { CompletionRewardView } from '@/lib/pack-completion-reward';

// Issue #1748: show_unowned_cards=true かつ show_unowned_card_details=false のとき、
// 未所持カードの name / image_url / description をサーバ側で落としてから
// client component へ渡すこと（RSC ペイロード経由の漏えい防止）。
// クライアント側のマスク表示テストは sorted-card-grid.test.tsx が担う。
const cfg = vi.hoisted(() => ({
  show_unowned_cards: true,
  show_unowned_card_details: false,
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

type CardProp = { id: string; name: string; image_url: string | null; description: string | null; isOwned: boolean };

beforeEach(() => {
  cfg.show_unowned_cards = true;
  cfg.show_unowned_card_details = false;
  cfg.rewardCount = 0;
  cfg.rewardState = 'granted';
});

it('strips unowned card details server-side when details are hidden (Issue #1748)', async () => {
  cfg.show_unowned_cards = true;
  cfg.show_unowned_card_details = false;
  const element = await Page({ params: Promise.resolve({ streamerId: 'streamer' }) });
  const cards = element.props.cards as CardProp[];
  expect(cards).toHaveLength(2);
  const unowned = cards.find((c) => c.id === 'unowned-1');
  expect(unowned?.isOwned).toBe(false);
  // RSC ペイロードに実データが含まれないこと
  expect(unowned?.name).toBe('');
  expect(unowned?.image_url).toBeNull();
  expect(unowned?.description).toBeNull();
  // 所持カードは影響を受けない
  const owned = cards.find((c) => c.id === 'owned-1');
  expect(owned?.name).toBe('OwnedCard');
  expect(owned?.image_url).toBe('https://example.com/owned.png');
  expect(element.props.hideUnownedDetails).toBe(true);
});

it('keeps unowned card details in public mode (show_unowned_card_details=true)', async () => {
  cfg.show_unowned_cards = true;
  cfg.show_unowned_card_details = true;
  const element = await Page({ params: Promise.resolve({ streamerId: 'streamer' }) });
  const cards = element.props.cards as CardProp[];
  const unowned = cards.find((c) => c.id === 'unowned-1');
  expect(unowned?.name).toBe('SecretCard');
  expect(unowned?.image_url).toBe('https://example.com/secret.png');
  expect(unowned?.description).toBe('秘密の説明');
  expect(element.props.hideUnownedDetails).toBe(false);
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
