import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reportError } from '@/lib/sentry/error-handler';
import { logger } from '@/lib/logger';
import { getDb } from '@/lib/db/client';
import { collectionCompletions as collectionCompletionsTable } from '@/lib/db/schema';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn().mockResolvedValue(undefined),
  // logger.server のerror経路が開始する永続化は、この単体テストでは副作用なく完了させる。
  logErrorFromLogger: vi.fn().mockResolvedValue(undefined),
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

  /**
   * #663 Category A: PlanetScale の plain INSERT、制約違反、デプロイ窓を検証する。
   */
  describe('insertCompletionRecord: PlanetScale 経路 (#663 Category A)', () => {
    interface PgInsertResponse {
      error?: { code: string };
    }

    function createDrizzleInsertMock(responses: PgInsertResponse[] = [{}]) {
      let callIndex = 0;
      const calls: Array<{ table: unknown; values?: Record<string, unknown> }> = [];
      const db = {
        insert: vi.fn((table: unknown) => {
          const response = responses[Math.min(callIndex, responses.length - 1)];
          callIndex += 1;
          const call: { table: unknown; values?: Record<string, unknown> } = { table };
          calls.push(call);
          const resolve = () =>
            response.error ? Promise.reject(response.error) : Promise.resolve([]);
          const builder: any = {
            values: vi.fn((values: Record<string, unknown>) => {
              call.values = values;
              return builder;
            }),
            then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
          };
          return builder;
        }),
      };
      return { db, calls };
    }

    it('recordCollectionCompletion は collection_name を含まない values で insert する', async () => {
      const { db, calls } = createDrizzleInsertMock();
      vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any);
      const { recordCollectionCompletion } = await import('@/lib/dashboard-data');

      await recordCollectionCompletion('user1', 'streamer1', 5);

      expect(calls).toHaveLength(1);
      expect(calls[0].table).toBe(collectionCompletionsTable);
      expect(calls[0].values).toEqual({
        twitch_user_id: 'user1',
        streamer_id: 'streamer1',
        total_cards: 5,
      });
      expect('collection_name' in (calls[0].values ?? {})).toBe(false);
    });

    it('recordPackCompletion は collection_name (パックキー) を含めて insert する', async () => {
      const { db, calls } = createDrizzleInsertMock();
      vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any);
      const { recordPackCompletion } = await import('@/lib/dashboard-data');

      await recordPackCompletion('user1', 'streamer1', 3, 'weapons');

      expect(calls[0].values).toEqual({
        twitch_user_id: 'user1',
        streamer_id: 'streamer1',
        total_cards: 3,
        collection_name: 'weapons',
      });
    });

    it('一意制約違反(SQLSTATE 23505)は既達成の正常系として黙って成功扱いにする', async () => {
      const { db } = createDrizzleInsertMock([{ error: { code: '23505' } }]);
      vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any);
      const { recordCollectionCompletion } = await import('@/lib/dashboard-data');

      await expect(recordCollectionCompletion('user1', 'streamer1', 5)).resolves.toBeUndefined();
      expect(logger.error).not.toHaveBeenCalled();
      expect(reportError).not.toHaveBeenCalled();
    });

    it('collection_name 列未デプロイ(SQLSTATE 42703)は静かにスキップする(デプロイ窓)', async () => {
      const { db } = createDrizzleInsertMock([{ error: { code: '42703' } }]);
      vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any);
      const { recordPackCompletion } = await import('@/lib/dashboard-data');

      await expect(
        recordPackCompletion('user1', 'streamer1', 3, 'weapons')
      ).resolves.toBeUndefined();
      expect(logger.error).not.toHaveBeenCalled();
      expect(reportError).not.toHaveBeenCalled();
    });

    it('42703以外のエラーは logger.error + reportError する', async () => {
      const { db } = createDrizzleInsertMock([{ error: { code: '42501' } }]);
      vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any);
      const { recordCollectionCompletion } = await import('@/lib/dashboard-data');

      await expect(recordCollectionCompletion('user1', 'streamer1', 5)).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalled();
      expect(reportError).toHaveBeenCalled();
    });

    it('予期しない例外時にもthrowしない（fire-and-forget）', async () => {
      const db = {
        insert: vi.fn(() => {
          throw new Error('network error');
        }),
      };
      vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any);
      const { recordCollectionCompletion } = await import('@/lib/dashboard-data');

      await expect(recordCollectionCompletion('user1', 'streamer1', 5)).resolves.toBeUndefined();
    });

  });

  describe('getCollectionCompletions', () => {
    function primeSelectResponses(
      responses: Array<{ rows?: Array<Record<string, unknown>>; error?: unknown }>,
    ) {
      let index = 0;
      const select = vi.fn((fields: Record<string, unknown>) => {
        const response = responses[Math.min(index, responses.length - 1)];
        index += 1;
        const builder: any = {
          from: vi.fn(() => builder),
          where: vi.fn(() => builder),
          orderBy: vi.fn(() => builder),
          limit: vi.fn(() => {
            if (response.error) return Promise.reject(response.error);
            const rows = response.rows ?? [];
            return Promise.resolve(
              rows.map((row) =>
                Object.fromEntries(
                  Object.keys(fields).map((key) => [key, row[key] ?? null]),
                ),
              ),
            );
          }),
        };
        return builder;
      });
      vi.mocked(getDb).mockResolvedValue({ db: { select }, sql: {} } as never);
      return select;
    }

    it('collection_name 付きでデータを返す', async () => {
      const mockData = [
        { total_cards: 8, completed_at: '2026-03-01T00:00:00Z', collection_name: null },
        { total_cards: 5, completed_at: '2026-02-01T00:00:00Z', collection_name: 'weapons' },
      ];
      const select = primeSelectResponses([{ rows: mockData }]);

      const { getCollectionCompletions } = await import('@/lib/dashboard-data');
      const result = await getCollectionCompletions('user1', 'streamer1');

      expect(result).toEqual(mockData);
      expect(select).toHaveBeenCalledTimes(1);
    });

    it('collection_name 列未デプロイ時は旧カラムで再取得し collection_name: null を補う', async () => {
      const legacyData = [{ total_cards: 8, completed_at: '2026-03-01T00:00:00Z' }];
      const select = primeSelectResponses([
        {
          error: Object.assign(
            new Error('column collection_completions.collection_name does not exist'),
            { code: '42703' },
          ),
        },
        { rows: legacyData },
      ]);

      const { getCollectionCompletions } = await import('@/lib/dashboard-data');
      const result = await getCollectionCompletions('user1', 'streamer1');

      expect(result).toEqual([
        { total_cards: 8, completed_at: '2026-03-01T00:00:00Z', collection_name: null },
      ]);
      expect(select).toHaveBeenCalledTimes(2);
    });

    it('エラー時は空配列を返す', async () => {
      primeSelectResponses([{ error: new Error('db error') }]);

      const { getCollectionCompletions } = await import('@/lib/dashboard-data');
      const result = await getCollectionCompletions('user1', 'streamer1');

      expect(result).toEqual([]);
    });

    it('一時的な接続断をリトライして復旧する', async () => {
      const mockData = [
        { total_cards: 8, completed_at: '2026-03-01T00:00:00Z', collection_name: null },
      ];
      const select = primeSelectResponses([
        {
          error: Object.assign(new Error('connection reset'), {
            code: 'ECONNRESET',
          }),
        },
        { rows: mockData },
      ]);

      const { getCollectionCompletions } = await import('@/lib/dashboard-data');
      const result = await getCollectionCompletions('user1', 'streamer1');

      expect(result).toEqual(mockData);
      expect(select).toHaveBeenCalledTimes(2);
    });
  });
});
