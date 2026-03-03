import { describe, it, expect, vi, beforeEach } from 'vitest';

// Supabase admin モック
const mockUpsert = vi.fn();
const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockOrder = vi.fn();

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      if (table !== 'collection_completions') throw new Error(`Unexpected table: ${table}`);
      return {
        upsert: mockUpsert,
        select: mockSelect,
      };
    },
  }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn().mockResolvedValue(undefined),
}));

// Next.js cache モック
vi.mock('next/cache', () => ({
  unstable_cache: (fn: () => Promise<unknown>) => fn,
}));

// react cache はパススルー
vi.mock('react', async () => {
  const actual = await vi.importActual('react');
  return { ...actual, cache: (fn: unknown) => fn };
});

// card-utils モック（dashboard-data.ts が import する）
vi.mock('@/lib/card-utils', () => ({
  normalizeDropRate: (cards: unknown[]) => cards,
}));

describe('collection-completions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('recordCollectionCompletion', () => {
    it('upsert を正しいパラメータで呼ぶ', async () => {
      mockUpsert.mockResolvedValue({ error: null });
      const { recordCollectionCompletion } = await import('@/lib/dashboard-data');

      await recordCollectionCompletion('user1', 'streamer1', 5);

      expect(mockUpsert).toHaveBeenCalledWith(
        { twitch_user_id: 'user1', streamer_id: 'streamer1', total_cards: 5 },
        { onConflict: 'twitch_user_id,streamer_id,total_cards', ignoreDuplicates: true },
      );
    });

    it('upsert エラー時にもthrowしない（fire-and-forget）', async () => {
      mockUpsert.mockResolvedValue({ error: { message: 'db error' } });
      const { recordCollectionCompletion } = await import('@/lib/dashboard-data');

      // 例外が飛ばないことを確認
      await expect(recordCollectionCompletion('user1', 'streamer1', 5)).resolves.toBeUndefined();
    });

    it('予期しない例外時にもthrowしない', async () => {
      mockUpsert.mockRejectedValue(new Error('network error'));
      const { recordCollectionCompletion } = await import('@/lib/dashboard-data');

      await expect(recordCollectionCompletion('user1', 'streamer1', 5)).resolves.toBeUndefined();
    });
  });

  describe('getCollectionCompletions', () => {
    it('データを正しく返す', async () => {
      const mockData = [
        { total_cards: 8, completed_at: '2026-03-01T00:00:00Z' },
        { total_cards: 5, completed_at: '2026-02-01T00:00:00Z' },
      ];
      mockSelect.mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({ data: mockData, error: null }),
          }),
        }),
      });

      const { getCollectionCompletions } = await import('@/lib/dashboard-data');
      const result = await getCollectionCompletions('user1', 'streamer1');

      expect(result).toEqual(mockData);
    });

    it('エラー時は空配列を返す', async () => {
      mockSelect.mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({ data: null, error: { message: 'db error' } }),
          }),
        }),
      });

      const { getCollectionCompletions } = await import('@/lib/dashboard-data');
      const result = await getCollectionCompletions('user1', 'streamer1');

      expect(result).toEqual([]);
    });
  });
});
