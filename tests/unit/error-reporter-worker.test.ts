import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker, { processErrors, processInquiries } from '../../workers/error-reporter/src/index';

// Reporter Worker（twica-error-reporter）は errors と support_inquiries の両方を
// GitHub Issue 化する。内部関数は export されていないため、
//   - scheduled: env 検証と「エラー/問い合わせの独立実行」を統合的にテスト
//   - processErrors / processInquiries: 各処理フローを個別にテスト
// global.fetch をモックして「どの外部 API を何回・どんな内容で叩いたか」を検証する。

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

const makeInquiry = (overrides = {}) => ({
  id: 'inq-1',
  twitch_user_id: 'user-123',
  twitch_display_name: 'TestUser',
  category: 'bug',
  subject: 'Test subject',
  body: 'Test body',
  status: 'open',
  created_at: '2026-01-01T00:00:00Z',
  ...overrides,
});

const mockEvent = {} as ScheduledController;
const mockCtx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

describe('reporter worker', () => {
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

  describe('scheduled: エラー処理と問い合わせ処理の独立実行', () => {
    it('両処理とも未処理なしなら fetch は2回（errors + support_inquiries のポーリング）', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) }); // errors
      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) }); // inquiries

      await worker.scheduled(mockEvent, mockEnv, mockCtx);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toContain('/rest/v1/errors');
      expect(fetchMock.mock.calls[1][0]).toContain('/rest/v1/support_inquiries');
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No pending errors'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No pending inquiries'));
    });

    it('エラー処理が失敗しても問い合わせ処理は実行される', async () => {
      // processErrors: fetchPendingErrors が 500 で失敗
      fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve('err') });
      // processInquiries: 未処理なし
      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) });

      await expect(worker.scheduled(mockEvent, mockEnv, mockCtx)).resolves.toBeUndefined();

      // エラー側は 'Cron job failed' を記録し、問い合わせ側は最後まで実行される
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('[Error Reporter] Cron job failed'),
        expect.any(Error)
      );
      expect(fetchMock.mock.calls[1][0]).toContain('/rest/v1/support_inquiries');
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No pending inquiries'));
    });
  });

  // ===========================================================================
  // processErrors（errors テーブル → GitHub Issue）
  // ===========================================================================
  describe('processErrors: 未処理エラーがない場合', () => {
    it('Supabase から空配列が返った場合は GitHub API を呼ばない', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) });

      await processErrors(mockEnv);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('No pending errors')
      );
    });
  });

  describe('processErrors: 新規 Issue 作成フロー', () => {
    it('未処理エラーがあり既存 Issue がない場合、新規 Issue を作成して処理済みマークする', async () => {
      const errorRecord = makeErrorRecord();

      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([errorRecord]) });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ total_count: 0, items: [] }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 42, html_url: 'https://github.com/test/42' }),
      });
      fetchMock.mockResolvedValueOnce({ ok: true });

      await processErrors(mockEnv);

      expect(fetchMock).toHaveBeenCalledTimes(4);

      const createIssueCall = fetchMock.mock.calls[2];
      expect(createIssueCall[0]).toContain('/repos/testowner/testrepo/issues');
      const createBody = JSON.parse(createIssueCall[1].body);
      expect(createBody.title).toContain('[preview]');
      expect(createBody.body).toContain('Signature:');
      expect(createBody.labels).toContain('bug');
      expect(createBody.labels).toContain('auto-generated');
      expect(createBody.labels).toContain('preview');

      const patchCall = fetchMock.mock.calls[3];
      expect(patchCall[0]).toContain('/rest/v1/errors');
      const patchBody = JSON.parse(patchCall[1].body);
      expect(patchBody.github_issue_created).toBe(true);
      expect(patchBody.github_issue_number).toBe(42);
    });
  });

  describe('processErrors: 既存 Issue へのコメント追加フロー', () => {
    it('既存 Issue がある場合はコメントを追加する', async () => {
      const errorRecord = makeErrorRecord();

      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([errorRecord]) });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          total_count: 1,
          items: [{ number: 10, html_url: 'https://github.com/test/10' }],
        }),
      });
      fetchMock.mockResolvedValueOnce({ ok: true });
      fetchMock.mockResolvedValueOnce({ ok: true });

      await processErrors(mockEnv);

      const commentCall = fetchMock.mock.calls[2];
      expect(commentCall[0]).toContain('/issues/10/comments');
      expect(commentCall[1].method).toBe('POST');
    });
  });

  describe('processErrors: addCommentToIssue 失敗時', () => {
    it('コメント追加失敗時は markErrorsAsProcessed がスキップされる', async () => {
      const errorRecord = makeErrorRecord();

      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([errorRecord]) });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          total_count: 1,
          items: [{ number: 10, html_url: 'https://github.com/test/10' }],
        }),
      });
      fetchMock.mockResolvedValueOnce({ ok: false, status: 403 });

      await processErrors(mockEnv);

      // markErrorsAsProcessed (PATCH) は呼ばれない（fetch は3回のみ）
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to process group'),
        expect.any(Error)
      );
    });
  });

  describe('processErrors: エラーグループ化（シグネチャ重複排除）', () => {
    it('同一メッセージのエラーは1つの Issue にまとめられる', async () => {
      const error1 = makeErrorRecord({ id: 'uuid-1', created_at: '2026-01-01T00:00:00Z' });
      const error2 = makeErrorRecord({ id: 'uuid-2', created_at: '2026-01-01T01:00:00Z' });

      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([error1, error2]) });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ total_count: 0, items: [] }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 50, html_url: 'https://github.com/test/50' }),
      });
      fetchMock.mockResolvedValueOnce({ ok: true });

      await processErrors(mockEnv);

      // Issue は1つだけ作成される（search 1回 + create 1回 + patch 1回）
      expect(fetchMock).toHaveBeenCalledTimes(4);

      const patchCall = fetchMock.mock.calls[3];
      expect(patchCall[0]).toContain('uuid-1');
      expect(patchCall[0]).toContain('uuid-2');
    });

    it('異なるメッセージのエラーは別々の Issue になる', async () => {
      const error1 = makeErrorRecord({ id: 'uuid-1', message: 'Error A' });
      const error2 = makeErrorRecord({ id: 'uuid-2', message: 'Error B' });

      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([error1, error2]) });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ total_count: 0, items: [] }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 51, html_url: 'https://github.com/test/51' }),
      });
      fetchMock.mockResolvedValueOnce({ ok: true });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ total_count: 0, items: [] }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 52, html_url: 'https://github.com/test/52' }),
      });
      fetchMock.mockResolvedValueOnce({ ok: true });

      await processErrors(mockEnv);

      expect(fetchMock).toHaveBeenCalledTimes(7);
    });
  });

  describe('processErrors: MAX_NEW_ISSUES_PER_RUN 制限', () => {
    it('1回の実行で最大5件の新規 Issue しか作成しない', async () => {
      const errors = Array.from({ length: 6 }, (_, i) =>
        makeErrorRecord({ id: `uuid-${i}`, message: `Error ${i}` })
      );

      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(errors) });

      for (let i = 0; i < 6; i++) {
        fetchMock.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ total_count: 0, items: [] }),
        });
        if (i < 5) {
          fetchMock.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ number: 100 + i, html_url: `https://github.com/test/${100 + i}` }),
          });
          fetchMock.mockResolvedValueOnce({ ok: true });
        }
      }

      await processErrors(mockEnv);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Max new issues limit')
      );
    });
  });

  describe('processErrors: Supabase API エラー', () => {
    it('fetchPendingErrors が失敗した場合は例外を投げる（scheduled 側で捕捉される）', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      await expect(processErrors(mockEnv)).rejects.toThrow(/Supabase fetch error/);
    });
  });

  describe('processErrors: production 環境のラベル', () => {
    it('production 環境のエラーには環境ラベルが付かない', async () => {
      const errorRecord = makeErrorRecord({ environment: 'production' });

      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([errorRecord]) });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ total_count: 0, items: [] }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 99, html_url: 'https://github.com/test/99' }),
      });
      fetchMock.mockResolvedValueOnce({ ok: true });

      await processErrors(mockEnv);

      const createBody = JSON.parse(fetchMock.mock.calls[2][1].body);
      expect(createBody.labels).toEqual(['bug', 'auto-generated']);
      expect(createBody.labels).not.toContain('production');
    });
  });

  // ===========================================================================
  // processInquiries（support_inquiries テーブル → GitHub Issue）
  // ===========================================================================
  describe('processInquiries: 未処理問い合わせがない場合', () => {
    it('空配列なら GitHub API を呼ばず、FIFO・limit=10 でポーリングする', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) });

      await processInquiries(mockEnv);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const fetchUrl = fetchMock.mock.calls[0][0];
      expect(fetchUrl).toContain('/rest/v1/support_inquiries');
      expect(fetchUrl).toContain('github_issue_created=eq.false');
      expect(fetchUrl).toContain('order=created_at.asc');
      expect(fetchUrl).toContain('limit=10');
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('No pending inquiries')
      );
    });
  });

  describe('processInquiries: 新規 Issue 作成フロー', () => {
    it('既存 Issue がない場合、新規 Issue を作成して処理済みマークする', async () => {
      const inquiry = makeInquiry();

      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([inquiry]) });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ total_count: 0, items: [] }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 42, html_url: 'https://github.com/test/42' }),
      });
      fetchMock.mockResolvedValueOnce({ ok: true });

      await processInquiries(mockEnv);

      expect(fetchMock).toHaveBeenCalledTimes(4);

      const createCall = fetchMock.mock.calls[2];
      expect(createCall[0]).toContain('/repos/testowner/testrepo/issues');
      expect(createCall[1].method).toBe('POST');
      const createBody = JSON.parse(createCall[1].body);
      expect(createBody.title).toContain('[問い合わせ/バグ報告]');
      expect(createBody.title).toContain('Test subject');
      expect(createBody.body).toContain('Inquiry-ID: inq-1');
      expect(createBody.body).toContain('TestUser');
      expect(createBody.labels).toContain('support-inquiry');
      expect(createBody.labels).toContain('auto-generated');

      const patchCall = fetchMock.mock.calls[3];
      expect(patchCall[0]).toContain('/rest/v1/support_inquiries');
      expect(patchCall[0]).toContain('id=eq.inq-1');
      expect(patchCall[1].method).toBe('PATCH');
      const patchBody = JSON.parse(patchCall[1].body);
      expect(patchBody.github_issue_created).toBe(true);
      expect(patchBody.github_issue_number).toBe(42);
      expect(patchBody.github_issue_url).toBe('https://github.com/test/42');
    });

    it('本文中のバッククォート連より長いフェンスで囲む（フェンス脱出防止）', async () => {
      const inquiry = makeInquiry({ body: 'contains ``` triple backticks' });

      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([inquiry]) });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ total_count: 0, items: [] }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 1, html_url: 'https://github.com/test/1' }),
      });
      fetchMock.mockResolvedValueOnce({ ok: true });

      await processInquiries(mockEnv);

      const createBody = JSON.parse(fetchMock.mock.calls[2][1].body);
      // 本文の最長 ``` (3連) より長い ```` (4連) フェンスで囲まれる
      expect(createBody.body).toContain('````\ncontains ``` triple backticks\n````');
    });
  });

  describe('processInquiries: 既存 Issue が見つかった場合（冪等性）', () => {
    it('既存 Issue があれば新規作成せず、それでも処理済みマークする', async () => {
      const inquiry = makeInquiry();

      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([inquiry]) });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          total_count: 1,
          items: [{ number: 10, html_url: 'https://github.com/test/10' }],
        }),
      });
      fetchMock.mockResolvedValueOnce({ ok: true });

      await processInquiries(mockEnv);

      // create を挟まないので fetch は3回（GET + search + PATCH）
      expect(fetchMock).toHaveBeenCalledTimes(3);

      const patchCall = fetchMock.mock.calls[2];
      expect(patchCall[0]).toContain('/rest/v1/support_inquiries');
      expect(patchCall[1].method).toBe('PATCH');
      const patchBody = JSON.parse(patchCall[1].body);
      expect(patchBody.github_issue_created).toBe(true);
      expect(patchBody.github_issue_number).toBe(10);

      const postedToIssues = fetchMock.mock.calls.some(
        (c) => typeof c[0] === 'string' && c[0].endsWith('/issues') && c[1]?.method === 'POST'
      );
      expect(postedToIssues).toBe(false);
    });
  });

  describe('processInquiries: 個別エラーの分離', () => {
    it('1件の作成が失敗しても他の問い合わせは処理される', async () => {
      const inquiry1 = makeInquiry({ id: 'inq-1' });
      const inquiry2 = makeInquiry({ id: 'inq-2' });

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([inquiry1, inquiry2]),
      });
      // inq-1: search なし → create 失敗（500）
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ total_count: 0, items: [] }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('server error'),
      });
      // inq-2: search なし → create 成功 → PATCH 成功
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ total_count: 0, items: [] }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 99, html_url: 'https://github.com/test/99' }),
      });
      fetchMock.mockResolvedValueOnce({ ok: true });

      await processInquiries(mockEnv);

      // GET(1) + inq-1[search, create-fail](2) + inq-2[search, create, patch](3) = 6
      expect(fetchMock).toHaveBeenCalledTimes(6);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to process inquiry inq-1'),
        expect.any(Error)
      );

      const lastCall = fetchMock.mock.calls[5];
      expect(lastCall[0]).toContain('id=eq.inq-2');
      expect(lastCall[1].method).toBe('PATCH');
    });
  });

  // 共通ヘルパへ集約したヘッダの契約を固定する（githubHeaders / supabase 認証ヘッダ改変時の回帰検知）
  describe('リクエストヘッダ契約', () => {
    it('GitHub POST と Supabase PATCH が期待するヘッダを送る', async () => {
      const inquiry = makeInquiry();
      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([inquiry]) });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ total_count: 0, items: [] }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 7, html_url: 'https://github.com/test/7' }),
      });
      fetchMock.mockResolvedValueOnce({ ok: true });

      await processInquiries(mockEnv);

      const createHeaders = fetchMock.mock.calls[2][1].headers;
      expect(createHeaders['Authorization']).toBe('Bearer gh-token');
      expect(createHeaders['Accept']).toBe('application/vnd.github+json');
      expect(createHeaders['X-GitHub-Api-Version']).toBe('2022-11-28');
      expect(createHeaders['User-Agent']).toBe('twica-error-reporter');
      expect(createHeaders['Content-Type']).toBe('application/json');

      const patchHeaders = fetchMock.mock.calls[3][1].headers;
      expect(patchHeaders['apikey']).toBe('test-key');
      expect(patchHeaders['Authorization']).toBe('Bearer test-key');
      expect(patchHeaders['Content-Type']).toBe('application/json');
      expect(patchHeaders['Prefer']).toBe('return=minimal');
    });

    it('SUPABASE_SECRET_KEY が SERVICE_ROLE_KEY より優先される', async () => {
      const env = { ...mockEnv, SUPABASE_SECRET_KEY: 'secret-key' };
      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) });

      await processInquiries(env);

      expect(fetchMock.mock.calls[0][1].headers['apikey']).toBe('secret-key');
    });
  });

  describe('processInquiries: 入力の無害化とカテゴリ', () => {
    it('未知のカテゴリはそのまま表示される', async () => {
      const inquiry = makeInquiry({ category: 'weird' });
      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([inquiry]) });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ total_count: 0, items: [] }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 1, html_url: 'https://github.com/test/1' }),
      });
      fetchMock.mockResolvedValueOnce({ ok: true });

      await processInquiries(mockEnv);

      const createBody = JSON.parse(fetchMock.mock.calls[2][1].body);
      expect(createBody.title).toContain('[問い合わせ/weird]');
    });

    it('件名・表示名は inlineCode で無害化され、改行や markdown 注入を防ぐ', async () => {
      const inquiry = makeInquiry({
        twitch_display_name: '@everyone',
        subject: 'line1\n# fake heading',
      });
      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([inquiry]) });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ total_count: 0, items: [] }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 1, html_url: 'https://github.com/test/1' }),
      });
      fetchMock.mockResolvedValueOnce({ ok: true });

      await processInquiries(mockEnv);

      const createBody = JSON.parse(fetchMock.mock.calls[2][1].body);
      // 表示名はインラインコード化され、@everyone は生メンションとして展開されない
      expect(createBody.body).toContain('`@everyone`');
      // 件名の改行は空白へ畳まれ、行頭 '# ' の見出し注入は無効化される
      expect(createBody.body).toContain('`line1 # fake heading`');
      expect(createBody.body).not.toContain('\nline1\n# fake heading');
    });
  });
});
