import { beforeEach, expect, it, vi } from 'vitest';

/**
 * #726: /collection/[streamerId] forwards streamers.trade_enabled to
 * StreamerCollection so the "Trade" entry point appears only for channels
 * that allow trading. A row without the column (deploy-window safe-column
 * fallback) must fail closed.
 */
const streamerRow = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('@/lib/session', () => ({ getSession: async () => ({ twitchUserId: 'viewer' }) }));
vi.mock('@/lib/dashboard-data', () => ({
  getStreamerById: async () => streamerRow.current,
  getUserCardsForStreamer: async () => [],
  getActiveCardsForStreamer: async () => [],
  getCollectionCompletions: async () => [],
  recordCollectionCompletion: vi.fn(), recordPackCompletion: vi.fn(),
}));
vi.mock('@/lib/services/pack-completion-reward', () => ({
  applyPackCompletionRewards: async () => ({ views: [], cards: [], rewardCardIds: [] }),
}));
vi.mock('@/components/StreamerCollection', () => ({ default: () => null }));
import Page from '@/app/collection/[streamerId]/page';

beforeEach(() => {
  streamerRow.current = { id: 'streamer', card_pack_names: [] };
});

it.each([
  [true, true],
  [false, false],
  [undefined, false],
])('trade_enabled=%s → tradeEnabled=%s', async (tradeEnabled, expected) => {
  streamerRow.current = { ...streamerRow.current, trade_enabled: tradeEnabled };
  const element = await Page({ params: Promise.resolve({ streamerId: 'streamer' }) });
  expect(element.props.tradeEnabled).toBe(expected);
});
