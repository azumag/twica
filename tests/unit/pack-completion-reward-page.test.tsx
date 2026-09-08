import { it, expect, vi } from 'vitest';
const fixtures = vi.hoisted(() => ({
  normal: { id: 'normal', is_active: true, collection_name: 'A', count: 1, rarity: 'common', created_at: '2026-01-01' },
  bonus: { id: 'bonus', is_active: false, collection_name: 'A', count: 1, rarity: 'rare', created_at: '2026-01-02' },
}));
vi.mock('@/lib/session', () => ({ getSession: async () => ({ twitchUserId: 'viewer' }) }));
vi.mock('@/lib/dashboard-data', () => ({
  getStreamerById: async () => ({ id: 'streamer', card_pack_names: ['A'] }),
  getUserCardsForStreamer: async () => [fixtures.normal],
  getActiveCardsForStreamer: async () => [fixtures.normal],
  getCollectionCompletions: async () => [],
  recordCollectionCompletion: vi.fn(), recordPackCompletion: vi.fn(),
}));
vi.mock('@/lib/services/pack-completion-reward', () => ({
  applyPackCompletionRewards: async () => ({ views: [], cards: [fixtures.normal, fixtures.bonus], rewardCardIds: ['bonus'] }),
}));
vi.mock('@/components/StreamerCollection', () => ({ default: () => null }));
import Page from '@/app/collection/[streamerId]/page';
it('keeps overall and named pack completion at 1/1 after adding a reward to the owned grid', async () => {
  const element = await Page({ params: Promise.resolve({ streamerId: 'streamer' }) });
  expect(element.props.progress).toEqual({ owned: 1, total: 1 });
  expect(element.props.packs[0].progress).toEqual({ owned: 1, total: 1 });
  expect(element.props.cards).toHaveLength(2);
  expect(element.props.cards.find((c: { id: string }) => c.id === 'bonus').isCompletionReward).toBe(true);
});
