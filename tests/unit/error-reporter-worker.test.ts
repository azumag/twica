import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker, {
  processErrors,
  processInquiries,
  processEventSubParkBacklog,
  EVENTSUB_PARK_KEY_PREFIX,
  parseParkedEventSubKeyReceivedAt,
} from '../../workers/error-reporter/src/index';
// Major-3 契約テスト用: worker パッケージ自体は @opennextjs/cloudflare 依存のため
// import できないが、このテストファイルは両方を import できる（Fable レビューで確認済み）。
import { KEY_PREFIX as EVENTSUB_PARK_SOURCE_KEY_PREFIX, buildParkedEventSubKey } from '../../src/lib/maintenance/eventsub-park';

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

    it('未知カテゴリに改行/見出し注入を含んでいても inlineCode で無害化される', async () => {
      // category は DB の CHECK 制約 + API 側バリデーションで bug/feature/other に
      // 限定されるが、Worker 自身もこの不変条件に依存せず防御的であるべき。
      // label（フォールバック時は category そのもの）が本文にそのまま展開されず、
      // inlineCode を通ることを検証する。
      const inquiry = makeInquiry({ category: 'weird\n# injected heading' });
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
      expect(createBody.body).toContain('`weird # injected heading`');
      expect(createBody.body).not.toContain('\nweird\n# injected heading');
    });
  });

  describe('processInquiries: 冪等性の保険', () => {
    it('新規作成に成功しても処理済みマーク(PATCH)が失敗した場合は例外が伝播する', async () => {
      // フラグが false のまま残るため、次回実行時に search で拾われて重複作成が
      // 防がれる想定（本命の冪等性）。ここでは PATCH 失敗時に例外が正しく
      // 伝播し、個別 try/catch で処理が打ち切られることのみ検証する。
      const inquiry = makeInquiry();
      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([inquiry]) });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ total_count: 0, items: [] }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 5, html_url: 'https://github.com/test/5' }),
      });
      // PATCH 失敗
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('db error'),
      });

      await processInquiries(mockEnv);

      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to process inquiry inq-1'),
        expect.any(Error)
      );
    });

    it('GitHub Search API 自体が失敗した場合は既存なし扱いで新規作成に進む', async () => {
      // searchIssue は API 失敗時に例外を投げず null を返す設計（本命の冪等性は
      // github_issue_created フラグであり、search はあくまで補助のため）。
      const inquiry = makeInquiry();
      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([inquiry]) });
      // search 失敗（403 = レート制限等）
      fetchMock.mockResolvedValueOnce({ ok: false, status: 403 });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 8, html_url: 'https://github.com/test/8' }),
      });
      fetchMock.mockResolvedValueOnce({ ok: true });

      await processInquiries(mockEnv);

      // search 失敗後も create → patch まで進む
      expect(fetchMock).toHaveBeenCalledTimes(4);
      const createCall = fetchMock.mock.calls[2];
      expect(createCall[0]).toContain('/repos/testowner/testrepo/issues');
      expect(createCall[1].method).toBe('POST');
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('GitHub search API failed')
      );
    });
  });

  // ===========================================================================
  // processEventSubParkBacklog（RATE_LIMIT_KV の maintenance:eventsub:* backlog 監視）
  // errors/inquiries と異なり Supabase を叩かず、KV の list() だけを見る。
  // 「いつが最古か」の判定に現在時刻を使うため、fake timers で固定する。
  // ===========================================================================
  describe('processEventSubParkBacklog', () => {
    const FIXED_NOW = new Date('2026-01-01T12:00:00.000Z');

    /** KV list() のレスポンスをキー名の配列から組み立てる。 */
    const makeKvEnv = (keyNames: string[], listComplete = true) => ({
      ...mockEnv,
      RATE_LIMIT_KV: {
        list: vi.fn().mockResolvedValue({
          keys: keyNames.map((name) => ({ name })),
          list_complete: listComplete,
        }),
      },
    });

    /**
     * 基準時刻から指定分だけ過去の受信時刻を持つ退避キー名を組み立てる。
     * Major-3 対応: 以前はここでキー形式（プレフィックス・区切り文字）を独自に
     * 複製していた（実装2箇所 + このテストヘルパで計3箇所目の複製）。
     * src/lib/maintenance/eventsub-park.ts の本家 buildParkedEventSubKey を
     * そのまま使うことで、この複製を解消する。
     */
    const parkedKey = (minutesAgo: number, messageId = 'msg-1') => {
      const receivedAt = new Date(FIXED_NOW.getTime() - minutesAgo * 60_000).toISOString();
      return buildParkedEventSubKey(receivedAt, messageId);
    };

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(FIXED_NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('RATE_LIMIT_KV バインディングが無い場合はエラーログのみで GitHub API を呼ばない', async () => {
      // mockEnv には元々 RATE_LIMIT_KV が無い（Env 型でも optional）ため、
      // そのまま渡すだけで binding 未設定を再現できる。
      await processEventSubParkBacklog(mockEnv);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Missing RATE_LIMIT_KV binding')
      );
    });

    it('退避データが0件なら GitHub API を呼ばない', async () => {
      const env = makeKvEnv([]);

      await processEventSubParkBacklog(env);

      expect(env.RATE_LIMIT_KV.list).toHaveBeenCalledWith({
        prefix: 'maintenance:eventsub:',
        limit: 1000,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('No parked notifications')
      );
    });

    it('件数・経過時間ともに閾値未満なら GitHub API を呼ばない', async () => {
      // 3件、最古でも5分前（件数閾値10・経過時間閾値30分のどちらも未満）
      const env = makeKvEnv([parkedKey(5, 'a'), parkedKey(3, 'b'), parkedKey(1, 'c')]);

      await processEventSubParkBacklog(env);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Below threshold')
      );
    });

    it('件数が閾値(10件)以上なら Issue を新規作成する', async () => {
      const keys = Array.from({ length: 10 }, (_, i) => parkedKey(1, `msg-${i}`));
      const env = makeKvEnv(keys);

      // Major-2 対応後: 重複検索は GitHub Search API ではなく Issues List API
      // （labels=...&state=open）を使う。レスポンスは Issue オブジェクトの配列。
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      }); // list: 既存なし
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 123, html_url: 'https://github.com/test/123' }),
      }); // create

      await processEventSubParkBacklog(env);

      expect(fetchMock).toHaveBeenCalledTimes(2);

      const listCall = fetchMock.mock.calls[0];
      expect(listCall[0]).toContain('/repos/testowner/testrepo/issues?labels=');
      expect(listCall[0]).toContain(encodeURIComponent('eventsub-park-backlog'));
      expect(listCall[0]).toContain('state=open');

      const createCall = fetchMock.mock.calls[1];
      expect(createCall[0]).toContain('/repos/testowner/testrepo/issues');
      const createBody = JSON.parse(createCall[1].body);
      expect(createBody.title).toContain('10');
      expect(createBody.body).toContain('件数**: 10 件');
      expect(createBody.body).toContain('Monitor: eventsub-park-backlog');
      expect(createBody.labels).toEqual(['bug', 'auto-generated', 'maintenance', 'eventsub-park-backlog']);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Created issue #123')
      );
    });

    it('件数は閾値未満でも最古エントリが30分以上経過していれば Issue を新規作成する', async () => {
      const env = makeKvEnv([parkedKey(40, 'stale')]);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 5, html_url: 'https://github.com/test/5' }),
      });

      await processEventSubParkBacklog(env);

      const createBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(createBody.body).toContain('40 分');
    });

    it('既に専用ラベルの Open Issue がある場合は新規作成せずスキップする', async () => {
      const keys = Array.from({ length: 10 }, (_, i) => parkedKey(1, `msg-${i}`));
      const env = makeKvEnv(keys);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ number: 77, html_url: 'https://github.com/test/77' }]),
      });

      await processEventSubParkBacklog(env);

      // list のみ（create は呼ばれない）
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Open issue #77 already exists, skipping')
      );
    });

    it('list_complete=false（1000件上限到達）の場合は件数表示に + が付く', async () => {
      const keys = Array.from({ length: 10 }, (_, i) => parkedKey(1, `msg-${i}`));
      const env = makeKvEnv(keys, false);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 1, html_url: 'https://github.com/test/1' }),
      });

      await processEventSubParkBacklog(env);

      const createBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(createBody.title).toContain('10+');
      expect(createBody.body).toContain('10+ 件');
    });

    it('プレフィックスやフォーマットに一致しない不正なキーは最古エントリの判定から除外される', async () => {
      // 想定外の壊れたキーが先頭に混ざっていても、パース可能な最初のキー
      // （2番目、40分前）が最古として扱われる。件数（3件）には両方カウントされる。
      const env = makeKvEnv([
        'maintenance:eventsub:not-a-valid-timestamp:msg-broken',
        parkedKey(40, 'valid-oldest'),
        parkedKey(1, 'valid-newest'),
      ]);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 1, html_url: 'https://github.com/test/1' }),
      });

      await processEventSubParkBacklog(env);

      const createBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      // 件数は3件のまま、経過時間は壊れたキーを無視して40分と判定される
      expect(createBody.body).toContain('件数**: 3 件');
      expect(createBody.body).toContain('40 分');
    });

    it('Issue 作成が失敗した場合は例外を投げる（scheduled 側で捕捉される）', async () => {
      const keys = Array.from({ length: 10 }, (_, i) => parkedKey(1, `msg-${i}`));
      const env = makeKvEnv(keys);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('server error'),
      });

      await expect(processEventSubParkBacklog(env)).rejects.toThrow(/GitHub API error/);
    });

    // Major-2 対応: 重複防止の唯一のガードである Issues List API 自体が失敗した
    // 場合、fail-open（既存なし扱いで新規作成に進む）だと処理済みフラグという
    // 保険が無いこの監視では無制限に重複 Issue が作られうる。fail-closed
    // （例外を投げて Issue 作成をスキップさせる）になっていることを検証する。
    it('Major-2: 重複チェック(Issues List API)自体が失敗した場合は fail-closed で新規作成をスキップする', async () => {
      const keys = Array.from({ length: 10 }, (_, i) => parkedKey(1, `msg-${i}`));
      const env = makeKvEnv(keys);

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 502,
        text: () => Promise.resolve('bad gateway'),
      });

      await expect(processEventSubParkBacklog(env)).rejects.toThrow(/GitHub Issues List API error/);

      // list 呼び出しのみで、Issue 作成（POST /issues）には進んでいないこと。
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const postedToIssues = fetchMock.mock.calls.some(
        (c) => typeof c[0] === 'string' && c[0].endsWith('/repos/testowner/testrepo/issues') && c[1]?.method === 'POST'
      );
      expect(postedToIssues).toBe(false);
    });

    it('scheduled() の一部として実行され、閾値超過時は他の処理と独立して Issue を作成する', async () => {
      const keys = Array.from({ length: 10 }, (_, i) => parkedKey(1, `msg-${i}`));
      const env = makeKvEnv(keys);

      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) }); // errors
      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) }); // inquiries
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      }); // list
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 200, html_url: 'https://github.com/test/200' }),
      }); // create

      await worker.scheduled(mockEvent, env, mockCtx);

      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Created issue #200')
      );
    });

    it('scheduled() 経由で processEventSubParkBacklog が失敗しても他の処理は影響を受けない', async () => {
      const keys = Array.from({ length: 10 }, (_, i) => parkedKey(1, `msg-${i}`));
      const env = makeKvEnv(keys);

      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) }); // errors
      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) }); // inquiries
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      }); // list
      fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve('boom') }); // create fails

      await expect(worker.scheduled(mockEvent, env, mockCtx)).resolves.toBeUndefined();

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('[EventSub Park Monitor] Cron job failed:'),
        expect.any(Error)
      );
      // errors/inquiries 側は正常完了している
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No pending errors'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No pending inquiries'));
    });

    // =========================================================================
    // Major-1: tombstone による count===0 偽陰性の回帰テスト
    // =========================================================================
    describe('tombstone 追従（count===0 かつ list_complete=false の扱い）', () => {
      it('全ての追加ページでも生キーが見つからない場合は unknown 扱いとなり、0件と断定せず警告ログを出す', async () => {
        // 初回 + followup 上限（3回）分、常に keys=[] かつ list_complete=false を
        // 返し続ける = tombstone だけのページが延々と続く最悪ケースを再現する。
        const list = vi.fn().mockResolvedValue({ keys: [], list_complete: false, cursor: 'next' });
        const env = { ...mockEnv, RATE_LIMIT_KV: { list } };

        await processEventSubParkBacklog(env);

        // 初回1回 + followup上限3回 = 計4回 list が呼ばれる。
        expect(list).toHaveBeenCalledTimes(4);
        // 0件と断定して沈黙する「No parked notifications」ログは出ない。
        expect(console.log).not.toHaveBeenCalledWith(
          expect.stringContaining('No parked notifications')
        );
        // 代わりに unknown 状態を示す警告ログが出る。
        expect(console.warn).toHaveBeenCalledWith(
          expect.stringContaining('Unable to determine backlog state')
        );
        // 数値を信頼できないため、この回は Issue を起票しない。
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it('1ページ目が tombstone のみでも、followup ページで生キーが見つかれば正しく backlog として扱う', async () => {
        const keys = Array.from({ length: 10 }, (_, i) => parkedKey(1, `msg-${i}`));
        const list = vi
          .fn()
          // 1ページ目: tombstone のみ（生キー0件、未完了）
          .mockResolvedValueOnce({ keys: [], list_complete: false, cursor: 'cursor-1' })
          // followup 1回目で生キーが見つかる
          .mockResolvedValueOnce({
            keys: keys.map((name) => ({ name })),
            list_complete: true,
          });
        const env = { ...mockEnv, RATE_LIMIT_KV: { list } };

        fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) }); // list issues
        fetchMock.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ number: 300, html_url: 'https://github.com/test/300' }),
        }); // create

        await processEventSubParkBacklog(env);

        // 2回目の kv.list 呼び出しには1回目の cursor が渡っている。
        expect(list).toHaveBeenNthCalledWith(2, {
          prefix: 'maintenance:eventsub:',
          limit: 1000,
          cursor: 'cursor-1',
        });
        // unknown 扱いにはならず、通常どおり閾値超過として Issue が作成される。
        expect(console.warn).not.toHaveBeenCalledWith(
          expect.stringContaining('Unable to determine backlog state')
        );
        expect(console.log).toHaveBeenCalledWith(
          expect.stringContaining('Created issue #300')
        );
      });

      it('followup ページの途中で list_complete=true になれば、生キー0件のまま「0件」と正しく判定する', async () => {
        // tombstone ページが1回続いた後、2ページ目で list_complete=true かつ生キー0件
        // （＝本当に backlog が無かった）ケース。unknown にはならない。
        const list = vi
          .fn()
          .mockResolvedValueOnce({ keys: [], list_complete: false, cursor: 'cursor-1' })
          .mockResolvedValueOnce({ keys: [], list_complete: true });
        const env = { ...mockEnv, RATE_LIMIT_KV: { list } };

        await processEventSubParkBacklog(env);

        expect(list).toHaveBeenCalledTimes(2);
        expect(console.warn).not.toHaveBeenCalledWith(
          expect.stringContaining('Unable to determine backlog state')
        );
        expect(console.log).toHaveBeenCalledWith(
          expect.stringContaining('No parked notifications')
        );
        expect(fetchMock).not.toHaveBeenCalled();
      });
    });
  });

  // ===========================================================================
  // Major-3 契約テスト: eventsub-park.ts のキー形式と、worker 側の独立実装
  // （EVENTSUB_PARK_KEY_PREFIX / parseParkedEventSubKeyReceivedAt）が実際に
  // 一致することを検証する。コメントでの相互参照だけに頼らず、どちらかが
  // ドリフトしたらこのテストが機械的に赤くなるようにするための1本。
  // ===========================================================================
  describe('EventSub 退避キー形式の契約テスト（eventsub-park.ts と worker 実装のドリフト検知）', () => {
    it('プレフィックス定数が完全に一致する', () => {
      expect(EVENTSUB_PARK_KEY_PREFIX).toBe(EVENTSUB_PARK_SOURCE_KEY_PREFIX);
    });

    it('本家 buildParkedEventSubKey が生成したキーを worker 側のパーサが正しく解釈できる', () => {
      const receivedAt = '2026-03-15T09:30:00.123Z';
      const key = buildParkedEventSubKey(receivedAt, 'contract-test-message-id');

      expect(parseParkedEventSubKeyReceivedAt(key)).toBe(receivedAt);
    });

    it('worker 側のパーサは、本家プレフィックスと異なるキーを拒否する（誤って別名前空間のキーを拾わない）', () => {
      const foreignKey = `not-${EVENTSUB_PARK_SOURCE_KEY_PREFIX}2026-03-15T09:30:00.123Z:msg-1`;
      expect(parseParkedEventSubKeyReceivedAt(foreignKey)).toBeNull();
    });
  });
});
