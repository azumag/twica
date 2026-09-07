import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { Card } from '@/types/database';
const mocks = vi.hoisted(() => ({ sql: vi.fn(), getDb: vi.fn(), mode: 'off' }));
vi.mock('@/lib/db/client', () => ({ getDb: mocks.getDb }));
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock('@/lib/logger.server', () => ({ logger: { warn: vi.fn() } }));
vi.mock('@/lib/maintenance/state', () => ({ getMaintenanceState: () => ({ mode: mocks.mode }) }));
import { applyPackCompletionRewards, getPackCompletionRewards, getPackCompletionRewardGrants } from '@/lib/services/pack-completion-reward';
const normal = { id: 'normal', is_active: true, collection_name: null } as Card;
const bonus = { id: 'secret-id', name: 'Secret card', image_url: 'https://secret.example/card.png', rarity: 'rare', is_active: false } as Card;
let grants: { collection_name: string; reward_card_id: string }[];
let settings: { collection_name: string; reward_card_id: string; card: Card }[];
beforeEach(() => {
  mocks.mode = 'off'; mocks.sql.mockReset(); mocks.getDb.mockReset();
  grants = []; settings = [{ collection_name: '__default__', reward_card_id: bonus.id, card: bonus }];
  mocks.getDb.mockResolvedValue({ sql: mocks.sql });
  mocks.sql.mockImplementation(async (strings: TemplateStringsArray) => {
    const query = strings.join('?');
    if (query.includes('FROM public.pack_completion_rewards r')) return settings;
    if (query.includes('SELECT * FROM public.pack_completion_reward_grants')) return [...grants];
    if (query.includes('SELECT public.grant_pack_completion_reward')) {
      grants.push({ collection_name: '__default__', reward_card_id: bonus.id });
      return [{ result: { granted: true } }];
    }
    if (query.includes('GROUP BY c.id')) return [{ card: bonus, count: 1 }];
    throw new Error('Unexpected query');
  });
});
describe('completion rewards preserve collection safety', () => {
  it.each(['42501', '42P01', '08006'])('continues the page when reads fail with %s', async code => {
    mocks.getDb.mockRejectedValue({ code });
    expect(await getPackCompletionRewards('streamer')).toEqual([]);
    expect(await getPackCompletionRewardGrants('viewer', 'streamer')).toEqual([]);
  });
  it('skips grant queries entirely for a normal collection without rewards', async () => {
    settings = [];
    const owned = [{ ...normal, count: 1 }];
    const result = await applyPackCompletionRewards('viewer', 'streamer', [normal], owned);
    expect(result.cards).toEqual(owned);
    expect(mocks.sql).toHaveBeenCalledTimes(1);
  });
  it('never serializes locked card identities, names or images', async () => {
    const result = await applyPackCompletionRewards('viewer', 'streamer', [normal], []);
    expect(result.views).toEqual([{ collectionName: '__default__', state: 'locked', rarity: 'rare' }]);
    const serialized = JSON.stringify(result);
    for (const value of [bonus.id, bonus.name, bonus.image_url!]) expect(serialized).not.toContain(value);
  });
  it('shows a just-awarded card in the same response despite the old ownership cache', async () => {
    const result = await applyPackCompletionRewards('viewer', 'streamer', [normal], [{ ...normal, count: 1 }]);
    expect(result.views[0].state).toBe('grantedNow');
    expect(result.cards.find(c => c.id === bonus.id)?.count).toBe(1);
    expect(result.rewardCardIds).toEqual([bonus.id]);
  });
  it('does not repeat a reveal after a reload', async () => {
    grants.push({ collection_name: '__default__', reward_card_id: bonus.id });
    const result = await applyPackCompletionRewards('viewer', 'streamer', [normal], [{ ...normal, count: 1 }]);
    expect(result.views[0].state).toBe('granted');
    expect(mocks.sql.mock.calls.some(([strings]) => strings.join('').includes('SELECT public.grant_pack_completion_reward'))).toBe(false);
  });
  it('does not write during maintenance', async () => {
    mocks.mode = 'read-only';
    const result = await applyPackCompletionRewards('viewer', 'streamer', [normal], [{ ...normal, count: 1 }]);
    expect(result.views[0].state).toBe('locked');
    expect(grants).toEqual([]);
  });
  it('retains historical badges after a reward is removed', async () => {
    settings = []; grants.push({ collection_name: '__default__', reward_card_id: bonus.id });
    const result = await applyPackCompletionRewards('viewer', 'streamer', [normal], [{ ...bonus, count: 1 }]);
    expect(result.views).toEqual([]);
    expect(result.rewardCardIds).toEqual([bonus.id]);
  });
});
