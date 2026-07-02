import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reportError } from '@/lib/sentry/error-handler';
import { logger } from '@/lib/logger';

// Supabase admin モック
const mockInsert = vi.fn();
const mockSelect = vi.fn();

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      if (table !== 'collection_completions') throw new Error(`Unexpected table: ${table}`);
      return {
        insert: mockInsert,
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

// getCollectionCompletions 用の select チェーンモックを構築する
const chainedSelect = (order: ReturnType<typeof vi.fn>) => ({
  eq: vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({ order }),
  }),
});

describe('collection-completions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('recordCollectionCompletion', () => {
    it('collection_name カラムを一切含まない plain insert を行う（旧スキーマ互換）', async () => {
      // Issue #557: 部分UNIQUEインデックス化に伴い upsert(onConflict) は使えない。
      // 全体コンプリートは collection_name を省略した insert（旧スキーマでも動く）。
      mockInsert.mockResolvedValue({ error: null });
      const { recordCollectionCompletion } = await import('@/lib/dashboard-data');

      await recordCollectionCompletion('user1', 'streamer1', 5);

      expect(mockInsert).toHaveBeenCalledWith(
        { twitch_user_id: 'user1', streamer_id: 'streamer1', total_cards: 5 },
      );
      const payload = mockInsert.mock.calls[0][0];
      expect('collection_name' in payload).toBe(false);
    });

    it('一意制約違反(23505)は既達成の正常系として黙って成功扱いにする', async () => {
      mockInsert.mockResolvedValue({
        error: { code: '23505', message: 'duplicate key value violates unique constraint' },
      });
      const { recordCollectionCompletion } = await import('@/lib/dashboard-data');

      await expect(recordCollectionCompletion('user1', 'streamer1', 5)).resolves.toBeUndefined();
      expect(logger.error).not.toHaveBeenCalled();
      expect(reportError).not.toHaveBeenCalled();
    });

    it('23505以外のエラーは従来どおり logger.error + reportError する', async () => {
      mockInsert.mockResolvedValue({ error: { code: '42501', message: 'permission denied' } });
      const { recordCollectionCompletion } = await import('@/lib/dashboard-data');

      await expect(recordCollectionCompletion('user1', 'streamer1', 5)).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalled();
      expect(reportError).toHaveBeenCalled();
    });

    it('予期しない例外時にもthrowしない（fire-and-forget）', async () => {
      mockInsert.mockRejectedValue(new Error('network error'));
      const { recordCollectionCompletion } = await import('@/lib/dashboard-data');

      await expect(recordCollectionCompletion('user1', 'streamer1', 5)).resolves.toBeUndefined();
    });
  });

  describe('recordPackCompletion', () => {
    it('collection_name (パックキー) を含めて insert する', async () => {
      mockInsert.mockResolvedValue({ error: null });
      const { recordPackCompletion } = await import('@/lib/dashboard-data');

      await recordPackCompletion('user1', 'streamer1', 3, 'weapons');

      expect(mockInsert).toHaveBeenCalledWith({
        twitch_user_id: 'user1',
        streamer_id: 'streamer1',
        total_cards: 3,
        collection_name: 'weapons',
      });
    });

    it('一意制約違反(23505)は黙って成功扱いにする', async () => {
      mockInsert.mockResolvedValue({
        error: { code: '23505', message: 'duplicate key value violates unique constraint' },
      });
      const { recordPackCompletion } = await import('@/lib/dashboard-data');

      await expect(recordPackCompletion('user1', 'streamer1', 3, 'weapons')).resolves.toBeUndefined();
      expect(logger.error).not.toHaveBeenCalled();
      expect(reportError).not.toHaveBeenCalled();
    });

    it('collection_name 列未デプロイ(デプロイ窓)は静かにスキップする', async () => {
      // 書き込みパスの列欠落は PostgREST が PGRST204 を返す
      // (isMissingCollectionNameColumn が検知する既存パターン)。
      mockInsert.mockResolvedValue({
        error: {
          code: 'PGRST204',
          message: "Could not find the 'collection_name' column of 'collection_completions' in the schema cache",
        },
      });
      const { recordPackCompletion } = await import('@/lib/dashboard-data');

      await expect(recordPackCompletion('user1', 'streamer1', 3, 'weapons')).resolves.toBeUndefined();
      expect(logger.error).not.toHaveBeenCalled();
      expect(reportError).not.toHaveBeenCalled();
    });

    it('その他のエラーは logger.error + reportError する', async () => {
      mockInsert.mockResolvedValue({ error: { code: '42501', message: 'permission denied' } });
      const { recordPackCompletion } = await import('@/lib/dashboard-data');

      await expect(recordPackCompletion('user1', 'streamer1', 3, 'weapons')).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalled();
      expect(reportError).toHaveBeenCalled();
    });
  });

  describe('getCollectionCompletions', () => {
    it('collection_name 付きでデータを返す', async () => {
      const mockData = [
        { total_cards: 8, completed_at: '2026-03-01T00:00:00Z', collection_name: null },
        { total_cards: 5, completed_at: '2026-02-01T00:00:00Z', collection_name: 'weapons' },
      ];
      mockSelect.mockReturnValue(
        chainedSelect(vi.fn().mockResolvedValue({ data: mockData, error: null }))
      );

      const { getCollectionCompletions } = await import('@/lib/dashboard-data');
      const result = await getCollectionCompletions('user1', 'streamer1');

      expect(result).toEqual(mockData);
      expect(mockSelect).toHaveBeenCalledWith('total_cards, completed_at, collection_name');
    });

    it('collection_name 列未デプロイ時は旧カラムで再取得し collection_name: null を補う', async () => {
      // 読み取りパスの列欠落は PostgreSQL の 42703 ("does not exist")。
      const legacyData = [{ total_cards: 8, completed_at: '2026-03-01T00:00:00Z' }];
      mockSelect
        .mockReturnValueOnce(
          chainedSelect(vi.fn().mockResolvedValue({
            data: null,
            error: { code: '42703', message: 'column collection_completions.collection_name does not exist' },
          }))
        )
        .mockReturnValueOnce(
          chainedSelect(vi.fn().mockResolvedValue({ data: legacyData, error: null }))
        );

      const { getCollectionCompletions } = await import('@/lib/dashboard-data');
      const result = await getCollectionCompletions('user1', 'streamer1');

      expect(result).toEqual([
        { total_cards: 8, completed_at: '2026-03-01T00:00:00Z', collection_name: null },
      ]);
      expect(mockSelect).toHaveBeenNthCalledWith(2, 'total_cards, completed_at');
    });

    it('エラー時は空配列を返す', async () => {
      mockSelect.mockReturnValue(
        chainedSelect(vi.fn().mockResolvedValue({ data: null, error: { message: 'db error' } }))
      );

      const { getCollectionCompletions } = await import('@/lib/dashboard-data');
      const result = await getCollectionCompletions('user1', 'streamer1');

      expect(result).toEqual([]);
    });

    it('一時的な502エラーをリトライして復旧する', async () => {
      const mockData = [
        { total_cards: 8, completed_at: '2026-03-01T00:00:00Z', collection_name: null },
      ];
      const mockOrder = vi.fn()
        .mockResolvedValueOnce({ data: null, error: { message: 'error code: 502' } })
        .mockResolvedValueOnce({ data: mockData, error: null });
      mockSelect.mockImplementation(() => chainedSelect(mockOrder));

      const { getCollectionCompletions } = await import('@/lib/dashboard-data');
      const result = await getCollectionCompletions('user1', 'streamer1');

      expect(result).toEqual(mockData);
      expect(mockOrder).toHaveBeenCalledTimes(2);
    });
  });
});
