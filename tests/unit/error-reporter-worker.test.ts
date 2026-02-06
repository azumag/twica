import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../../workers/error-reporter/src/index';

// Worker の scheduled ハンドラをテストする
// 内部関数は export されていないため、scheduled 経由で統合的にテスト

const mockEnv = {
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  GITHUB_TOKEN: 'gh-token',
  GITHUB_REPO_OWNER: 'testowner',
  GITHUB_REPO_NAME: 'testrepo',
};

const makeErrorRecord = (overrides = {}) => ({
  id: 'uuid-1',
  error_type: '[Error]',
  message: 'Test error',
  stack_trace: 'Error: Test error\n    at test.ts:1',
  context: { key: 'value' },
  environment: 'preview',
  created_at: '2026-01-01T00:00:00Z',
  ...overrides,
});

const mockEvent = {} as ScheduledEvent;
const mockCtx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

describe('error-reporter worker', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    global.fetch = fetchMock;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('環境変数バリデーション', () => {
    it('SUPABASE_URL が未設定の場合は早期リターンする', async () => {
      await worker.scheduled(mockEvent, { ...mockEnv, SUPABASE_URL: '' }, mockCtx);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Missing required secrets')
      );
    });

    it('GITHUB_REPO_OWNER が未設定の場合は早期リターンする', async () => {
      await worker.scheduled(mockEvent, { ...mockEnv, GITHUB_REPO_OWNER: '' }, mockCtx);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Missing GITHUB_REPO_OWNER')
      );
    });

    it('GITHUB_REPO_NAME が未設定の場合は早期リターンする', async () => {
      await worker.scheduled(mockEvent, { ...mockEnv, GITHUB_REPO_NAME: '' }, mockCtx);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Missing GITHUB_REPO_OWNER')
      );
    });
  });

  describe('未処理エラーがない場合', () => {
    it('Supabase から空配列が返った場合は GitHub API を呼ばない', async () => {
      // fetchPendingErrors → 空配列
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

      await worker.scheduled(mockEvent, mockEnv, mockCtx);

      // Supabase への fetch のみ（GitHub API は呼ばれない）
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('No pending errors')
      );
    });
  });

  describe('新規 Issue 作成フロー', () => {
    it('未処理エラーがあり既存 Issue がない場合、新規 Issue を作成して処理済みマークする', async () => {
      const errorRecord = makeErrorRecord();

      // 1. fetchPendingErrors → エラー1件
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([errorRecord]),
      });
      // 2. findExistingIssue (GitHub search) → 該当なし
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ total_count: 0, items: [] }),
      });
      // 3. createGitHubIssue → 成功
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 42, html_url: 'https://github.com/test/42' }),
      });
      // 4. markErrorsAsProcessed (Supabase PATCH) → 成功
      fetchMock.mockResolvedValueOnce({
        ok: true,
      });

      await worker.scheduled(mockEvent, mockEnv, mockCtx);

      expect(fetchMock).toHaveBeenCalledTimes(4);

      // GitHub Issue 作成 API の呼び出しを検証
      const createIssueCall = fetchMock.mock.calls[2];
      expect(createIssueCall[0]).toContain('/repos/testowner/testrepo/issues');
      const createBody = JSON.parse(createIssueCall[1].body);
      expect(createBody.title).toContain('[preview]');
      expect(createBody.body).toContain('Signature:');
      expect(createBody.labels).toContain('bug');
      expect(createBody.labels).toContain('auto-generated');
      // preview 環境のラベルが追加される
      expect(createBody.labels).toContain('preview');

      // Supabase PATCH の呼び出しを検証
      const patchCall = fetchMock.mock.calls[3];
      expect(patchCall[0]).toContain('/rest/v1/errors');
      const patchBody = JSON.parse(patchCall[1].body);
      expect(patchBody.github_issue_created).toBe(true);
      expect(patchBody.github_issue_number).toBe(42);
    });
  });

  describe('既存 Issue へのコメント追加フロー', () => {
    it('既存 Issue がある場合はコメントを追加する', async () => {
      const errorRecord = makeErrorRecord();

      // 1. fetchPendingErrors
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([errorRecord]),
      });
      // 2. findExistingIssue → 既存 Issue あり
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          total_count: 1,
          items: [{ number: 10, html_url: 'https://github.com/test/10' }],
        }),
      });
      // 3. addCommentToIssue → 成功
      fetchMock.mockResolvedValueOnce({ ok: true });
      // 4. markErrorsAsProcessed → 成功
      fetchMock.mockResolvedValueOnce({ ok: true });

      await worker.scheduled(mockEvent, mockEnv, mockCtx);

      // コメント追加 API の呼び出しを検証
      const commentCall = fetchMock.mock.calls[2];
      expect(commentCall[0]).toContain('/issues/10/comments');
      expect(commentCall[1].method).toBe('POST');
    });
  });

  describe('addCommentToIssue 失敗時', () => {
    it('コメント追加失敗時は markErrorsAsProcessed がスキップされる', async () => {
      const errorRecord = makeErrorRecord();

      // 1. fetchPendingErrors
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([errorRecord]),
      });
      // 2. findExistingIssue → 既存 Issue あり
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          total_count: 1,
          items: [{ number: 10, html_url: 'https://github.com/test/10' }],
        }),
      });
      // 3. addCommentToIssue → 失敗（403）
      fetchMock.mockResolvedValueOnce({ ok: false, status: 403 });

      await worker.scheduled(mockEvent, mockEnv, mockCtx);

      // markErrorsAsProcessed (PATCH) は呼ばれない（fetch は3回のみ）
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to process group'),
        expect.any(Error)
      );
    });
  });

  describe('エラーグループ化（シグネチャ重複排除）', () => {
    it('同一メッセージのエラーは1つの Issue にまとめられる', async () => {
      const error1 = makeErrorRecord({ id: 'uuid-1', created_at: '2026-01-01T00:00:00Z' });
      const error2 = makeErrorRecord({ id: 'uuid-2', created_at: '2026-01-01T01:00:00Z' });

      // 1. fetchPendingErrors → 同一シグネチャのエラー2件
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([error1, error2]),
      });
      // 2. findExistingIssue → 該当なし
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ total_count: 0, items: [] }),
      });
      // 3. createGitHubIssue → 成功
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 50, html_url: 'https://github.com/test/50' }),
      });
      // 4. markErrorsAsProcessed → 成功
      fetchMock.mockResolvedValueOnce({ ok: true });

      await worker.scheduled(mockEvent, mockEnv, mockCtx);

      // Issue は1つだけ作成される（search 1回 + create 1回 + patch 1回）
      expect(fetchMock).toHaveBeenCalledTimes(4);

      // PATCH に両方の ID が含まれる
      const patchCall = fetchMock.mock.calls[3];
      expect(patchCall[0]).toContain('uuid-1');
      expect(patchCall[0]).toContain('uuid-2');
    });

    it('異なるメッセージのエラーは別々の Issue になる', async () => {
      const error1 = makeErrorRecord({ id: 'uuid-1', message: 'Error A' });
      const error2 = makeErrorRecord({ id: 'uuid-2', message: 'Error B' });

      // 1. fetchPendingErrors → 異なるシグネチャのエラー2件
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([error1, error2]),
      });
      // 2. findExistingIssue(group1) → なし
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ total_count: 0, items: [] }),
      });
      // 3. createGitHubIssue(group1)
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 51, html_url: 'https://github.com/test/51' }),
      });
      // 4. markErrorsAsProcessed(group1)
      fetchMock.mockResolvedValueOnce({ ok: true });
      // 5. findExistingIssue(group2) → なし
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ total_count: 0, items: [] }),
      });
      // 6. createGitHubIssue(group2)
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 52, html_url: 'https://github.com/test/52' }),
      });
      // 7. markErrorsAsProcessed(group2)
      fetchMock.mockResolvedValueOnce({ ok: true });

      await worker.scheduled(mockEvent, mockEnv, mockCtx);

      // 2つの Issue が作成される
      expect(fetchMock).toHaveBeenCalledTimes(7);
    });
  });

  describe('MAX_NEW_ISSUES_PER_RUN 制限', () => {
    it('1回の実行で最大5件の新規 Issue しか作成しない', async () => {
      // 6つの異なるエラーを生成
      const errors = Array.from({ length: 6 }, (_, i) =>
        makeErrorRecord({ id: `uuid-${i}`, message: `Error ${i}` })
      );

      // 1. fetchPendingErrors
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(errors),
      });

      // 各グループに対して search → create → patch を繰り返す
      for (let i = 0; i < 6; i++) {
        // findExistingIssue → なし
        fetchMock.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ total_count: 0, items: [] }),
        });
        if (i < 5) {
          // createGitHubIssue
          fetchMock.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ number: 100 + i, html_url: `https://github.com/test/${100 + i}` }),
          });
          // markErrorsAsProcessed
          fetchMock.mockResolvedValueOnce({ ok: true });
        }
      }

      await worker.scheduled(mockEvent, mockEnv, mockCtx);

      // 6番目のグループは search のみで create されない
      // fetch: 1 (pendingErrors) + 5 * 3 (search+create+patch) + 1 (search for 6th) = 17
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Max new issues limit')
      );
    });
  });

  describe('Supabase API エラー', () => {
    it('fetchPendingErrors が失敗しても例外を外に漏らさない', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      // 例外が投げられないことを確認（scheduled 内の try-catch で捕捉される）
      await expect(worker.scheduled(mockEvent, mockEnv, mockCtx)).resolves.toBeUndefined();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Cron job failed'),
        expect.any(Error)
      );
    });
  });

  describe('production 環境のラベル', () => {
    it('production 環境のエラーには環境ラベルが付かない', async () => {
      const errorRecord = makeErrorRecord({ environment: 'production' });

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([errorRecord]),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ total_count: 0, items: [] }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 99, html_url: 'https://github.com/test/99' }),
      });
      fetchMock.mockResolvedValueOnce({ ok: true });

      await worker.scheduled(mockEvent, mockEnv, mockCtx);

      const createBody = JSON.parse(fetchMock.mock.calls[2][1].body);
      expect(createBody.labels).toEqual(['bug', 'auto-generated']);
      expect(createBody.labels).not.toContain('production');
    });
  });
});
