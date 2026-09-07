import { beforeEach, describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ sql: vi.fn(), session: vi.fn(), csrf: vi.fn(), limit: vi.fn() }));
vi.mock('@/lib/csrf', () => ({ validateCSRFToken: mocks.csrf }));
vi.mock('@/lib/session', () => ({ getSession: mocks.session, canUseStreamerFeatures: () => true }));
vi.mock('@/lib/db/client', () => ({ getDb: vi.fn(async () => ({ sql: mocks.sql })) }));
vi.mock('@/lib/rate-limit', () => ({ getRateLimitIdentifier: vi.fn(), checkRateLimit: mocks.limit, rateLimits: { streamerSettings: {} } }));
vi.mock('next/cache', () => ({ revalidateTag: vi.fn(), unstable_cache: (fn: unknown) => fn }));
import { GET, PUT, DELETE } from '@/app/api/streamer/pack-completion-rewards/route';
import { getDb } from '@/lib/db/client';
import { revalidateTag } from 'next/cache';
const card = '00000000-0000-0000-0000-000000000004';
function request(method: string, body?: unknown) {
  return new NextRequest('https://twica.live/api/streamer/pack-completion-rewards', {
    method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.sql.mockReset();
  mocks.csrf.mockResolvedValue({ valid: true }); mocks.session.mockResolvedValue({ twitchUserId: 'viewer' });
  mocks.limit.mockResolvedValue({ success: true });
});
describe('completion reward API access and validation', () => {
  it.each([['PUT', PUT], ['DELETE', DELETE]] as const)('rejects %s without CSRF before database access', async (method, handler) => {
    mocks.csrf.mockResolvedValue({ valid: false });
    expect((await handler(request(method))).status).toBe(403);
    expect(getDb).not.toHaveBeenCalled();
  });
  it('rejects unauthenticated reads', async () => {
    mocks.session.mockResolvedValue(null);
    expect((await GET(request('GET'))).status).toBe(401);
    expect(getDb).not.toHaveBeenCalled();
  });
  it('rate limits before querying the database', async () => {
    mocks.limit.mockResolvedValue({ success: false });
    expect((await GET(request('GET'))).status).toBe(429);
    expect(getDb).not.toHaveBeenCalled();
  });
  it('rejects malformed card identifiers without SQL', async () => {
    expect((await PUT(request('PUT', { collectionName: 'A', rewardCardId: 'invalid' }))).status).toBe(400);
    expect(getDb).not.toHaveBeenCalled();
  });
  it.each(['card_active', 'card_not_found', 'pack_not_found'])('maps authoritative RPC rejection %s to 400', async reason => {
    mocks.sql.mockResolvedValueOnce([{ id: 'owned-streamer' }]).mockResolvedValueOnce([{ result: { ok: false, reason } }]);
    const response = await PUT(request('PUT', { collectionName: 'A', rewardCardId: card, streamerId: 'someone-else' }));
    expect(response.status).toBe(400);
    expect(mocks.sql.mock.calls[1][1]).toBe('owned-streamer');
    expect(revalidateTag).not.toHaveBeenCalled();
  });
  it('invalidates settings only after successful persistence', async () => {
    mocks.sql.mockResolvedValueOnce([{ id: 'owned-streamer' }]).mockResolvedValueOnce([{ result: { ok: true } }]);
    expect((await PUT(request('PUT', { collectionName: '__default__', rewardCardId: card }))).status).toBe(200);
    expect(revalidateTag).toHaveBeenCalledWith('pack-completion-rewards-owned-streamer', { expire: 0 });
  });
  it('reports schema not ready without claiming a save succeeded', async () => {
    mocks.sql.mockResolvedValueOnce([{ id: 'owned-streamer' }]).mockRejectedValueOnce({ code: '42883' });
    const response = await PUT(request('PUT', { collectionName: 'A', rewardCardId: card }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ unavailable: true });
    expect(revalidateTag).not.toHaveBeenCalled();
  });
});

it('allows removing an orphan and preserves grant history', async () => {
  const tx = vi.fn().mockResolvedValue([]);
  Object.assign(mocks.sql, { begin: vi.fn(async (fn: (query: typeof tx) => Promise<void>) => fn(tx)) });
  mocks.sql.mockResolvedValueOnce([{ id: 'owned-streamer' }]);
  const response = await DELETE(request('DELETE', { collectionName: 'deleted-pack' }));
  expect(response.status).toBe(200);
  expect(tx.mock.calls[0][0].join('')).toContain('FOR UPDATE');
  expect(tx.mock.calls[1][0].join('')).toContain('DELETE FROM public.pack_completion_rewards');
  expect(tx.mock.calls.flat().join('')).not.toContain('DELETE FROM public.pack_completion_reward_grants');
});
