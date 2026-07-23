import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker, {
  processErrors,
  processInquiries,
  processEventSubParkBacklog,
  processEventSubParkAutoDrain,
  EVENTSUB_PARK_KEY_PREFIX,
  EVENTSUB_AUTO_DRAIN_CRON,
  parseParkedEventSubKeyReceivedAt,
  stripPostgresJsIncompatibleSslParams,
} from '../../workers/error-reporter/src/index';
// Major-3 契約テスト用: worker パッケージ自体は @opennextjs/cloudflare 依存のため
// import できないが、このテストファイルは両方を import できる（Fable レビューで確認済み）。
import { KEY_PREFIX as EVENTSUB_PARK_SOURCE_KEY_PREFIX, buildParkedEventSubKey } from '../../src/lib/maintenance/eventsub-park';
// #711 C 契約テスト用: worker 内の stripPostgresJsIncompatibleSslParams は
// scripts/lib/db-migrate-core.js の同名関数の独立コピー（分析パッケージと同じ
// 理由でクロスパッケージ import を避けている）。正本の実装も import して
// 代表的な入力で出力一致を検証し、複製のドリフトを機械的に検知する。
import { stripPostgresJsIncompatibleSslParams as stripPostgresJsIncompatibleSslParamsSource } from '../../scripts/lib/db-migrate-core.js';

// Reporter Worker（twica-error-reporter）は errors と support_inquiries の両方を
// GitHub Issue 化する。内部関数は export されていないため、
//   - scheduled: env 検証と「エラー/問い合わせの独立実行」を統合的にテスト
//   - processErrors / processInquiries: 各処理フローを個別にテスト
// global.fetch をモックして「どの外部 API を何回・どんな内容で叩いたか」を検証する。
//
// #711 C: errors/support_inquiries への DB アクセスは PostgREST（fetch 直叩き）から
// postgres.js 直結（Hyperdrive 経由）へ移行した。GitHub Issues API（search/create/
// comment）は引き続き fetch のモックで検証するが、DB 側（SELECT/UPDATE）は
// 下記 mockSql（'postgres' パッケージ全体のモック）で検証する。

// postgres.js の `sql` はタグ付きテンプレート呼び出し（`sql\`SELECT ...\``）で
// 使われる「ただの関数」なので、vi.fn() でそのまま模倣できる。
// `sql.options.parsers` は createReporterDbClient 内の installRawTimestampParser が
// 代入するため、モックにも同じ形の入れ物（options.parsers オブジェクト）を
// 用意しておく（実際のパース処理はテスト対象外。created_at はテストデータとして
// あらかじめ文字列で用意するため、登録されたパーサ自体は呼ばれない）。
//
// vi.hoisted を使う理由: vi.mock ファクトリは巻き上げ（hoisting）されるため、
// 外側スコープの変数をクロージャ経由で直接参照できない。vi.hoisted で先に
// 生成した参照（postgresFactoryMock）をファクトリ内から参照し、実際に返す
// sql モックは beforeEach ごとに setMockSql で差し替える（fetchMock を
// beforeEach で毎回 vi.fn() し直すのと同じく、テスト間で queue が漏れないようにする）。
const { postgresFactoryMock, setMockSql } = vi.hoisted(() => {
  let currentSql: unknown = null;
  // postgres() のシグネチャは (connectionString, options) だが、この mock 実装
  // 自体は引数を使わない（呼び出し引数は postgresFactoryMock.mock.calls 側で
  // 別途検証する）ため未使用パラメータは宣言しない。一方 vi.fn() の型引数だけ
  // `(...args: unknown[]) => unknown` を明示することで、mock.calls[i] が
  // 空タプル `[]` ではなく `unknown[]` に推論され、`postgresFactoryMock.mock.calls[0]`
  // を index アクセスしてもコンパイルエラーにならない（呼び出し時の実引数は
  // JS の性質上そのまま渡っても実装側で単に無視されるため実害は無い）。
  const factory = vi.fn<(...args: unknown[]) => unknown>(() => currentSql);
  return {
    postgresFactoryMock: factory,
    setMockSql: (sql: unknown) => {
      currentSql = sql;
    },
  };
});

vi.mock('postgres', () => ({
  default: postgresFactoryMock,
}));

/** mockSql.mock.calls[i] からクエリ本文を復元する（プレースホルダは '?' に潰す）。 */
function sqlText(call: readonly unknown[]): string {
  const strings = call[0] as readonly string[];
  return strings.join('?');
}

const mockEnv = {
  HYPERDRIVE_SUPABASE: { connectionString: 'postgres://mock:mock@localhost:5432/mock' },
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
  let mockSql: ReturnType<typeof vi.fn> & { options: { parsers: Record<number, unknown> } };

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    global.fetch = fetchMock;

    // DB モック: 呼び出しごとに新しい sql モックを用意し（fetchMock と同じ方針）、
    // postgres() ファクトリが常にこのテストのモックを返すよう差し替える。
    mockSql = vi.fn() as unknown as typeof mockSql;
    mockSql.options = { parsers: {} };
    setMockSql(mockSql);
    postgresFactoryMock.mockClear();

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('環境変数バリデーション', () => {
    it('HYPERDRIVE_SUPABASE バインディングが未設定の場合は早期リターンする', async () => {
      // HYPERDRIVE_SUPABASE は Env 型で optional なため、undefined を明示する
      // だけで「未設定」を再現できる（rest 分割代入による省略パターンは
      // 使わない未使用変数を生む＝eslint no-unused-vars 警告の元になるため避ける）。
      const envWithoutHyperdrive = { ...mockEnv, HYPERDRIVE_SUPABASE: undefined };
      await worker.scheduled(mockEvent, envWithoutHyperdrive, mockCtx);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockSql).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Missing required binding/secrets')
      );
    });

    it('GITHUB_TOKEN が未設定の場合は早期リターンする', async () => {
      await worker.scheduled(mockEvent, { ...mockEnv, GITHUB_TOKEN: '' }, mockCtx);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockSql).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Missing required binding/secrets')
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

  describe('createReporterDbClient (#711 C)', () => {
    it('HYPERDRIVE_SUPABASE 未設定で processErrors を直接呼ぶと例外を投げる', async () => {
      // HYPERDRIVE_SUPABASE は Env 型で optional なため、undefined を明示する
      // だけで「未設定」を再現できる（rest 分割代入による省略パターンは
      // 使わない未使用変数を生む＝eslint no-unused-vars 警告の元になるため避ける）。
      const envWithoutHyperdrive = { ...mockEnv, HYPERDRIVE_SUPABASE: undefined };
      await expect(processErrors(envWithoutHyperdrive)).rejects.toThrow(
        /Missing HYPERDRIVE_SUPABASE binding/
      );
      expect(mockSql).not.toHaveBeenCalled();
    });

    it('postgres() を max:1 で呼び、fetch_types:false は指定しない（配列パラメータ ANY() が壊れるため）', async () => {
      // 実機の Postgres で fetch_types:false + `ANY($1::uuid[])` が
      // "malformed array literal" で失敗することを確認済み（ローカル Docker 検証）。
      // 一度直っても再度 fetch_types:false が混入すると markErrorsAsProcessed が
      // 本番で壊れるため、オプションの回帰を検知する。
      mockSql.mockResolvedValueOnce([]);
      await processErrors(mockEnv);

      expect(postgresFactoryMock).toHaveBeenCalledTimes(1);
      const [connectionString, options] = postgresFactoryMock.mock.calls[0];
      expect(connectionString).toBe(mockEnv.HYPERDRIVE_SUPABASE.connectionString);
      expect(options).toMatchObject({ max: 1 });
      expect(options).not.toHaveProperty('fetch_types');
    });

    it('timestamptz(OID 1184) 用の raw パーサを最初のクエリ発行前に登録する', async () => {
      mockSql.mockResolvedValueOnce([]);
      await processErrors(mockEnv);

      const parser = mockSql.options.parsers[1184] as ((v: string) => string) | undefined;
      expect(typeof parser).toBe('function');
      // identity 関数であること（Date へ変換せず生のワイヤ形式文字列を素通しする）
      expect(parser?.('2026-07-21 12:34:56.789+00')).toBe('2026-07-21 12:34:56.789+00');
    });
  });

  describe('stripPostgresJsIncompatibleSslParams の複製ドリフト検知契約テスト', () => {
    // scripts/lib/db-migrate-core.js が正本。worker 側は別デプロイ単位のため
    // 独立コピーを持つ（analysis/dev/adminApiPg.ts と同じ理由、ファイル内コメント参照）。
    it.each([
      'postgres://user:pass@host/db?sslmode=verify-full&sslrootcert=system',
      'postgres://user:pass@host/db?sslrootcert=system',
      'postgres://user:pass@host/db?sslmode=require',
      'postgres://user:pass@host/db',
      'not a valid url',
      '',
    ])('入力 %s で正本と同じ出力になる', (input) => {
      expect(stripPostgresJsIncompatibleSslParams(input)).toBe(
        stripPostgresJsIncompatibleSslParamsSource(input)
      );
    });
  });

  describe('scheduled: エラー処理と問い合わせ処理の独立実行', () => {
    it('両処理とも未処理なしなら DB SELECT は2回（errors + support_inquiries のポーリング）、GitHub API は呼ばない', async () => {
      mockSql.mockResolvedValueOnce([]); // errors select
      mockSql.mockResolvedValueOnce([]); // inquiries select

      await worker.scheduled(mockEvent, mockEnv, mockCtx);

      expect(mockSql).toHaveBeenCalledTimes(2);
      expect(sqlText(mockSql.mock.calls[0])).toContain('FROM errors');
      expect(sqlText(mockSql.mock.calls[1])).toContain('FROM support_inquiries');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No pending errors'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No pending inquiries'));
    });

    it('エラー処理が失敗しても問い合わせ処理は実行される', async () => {
      // processErrors: fetchPendingErrors (SELECT) が失敗
      mockSql.mockRejectedValueOnce(new Error('connection refused'));
      // processInquiries: 未処理なし
      mockSql.mockResolvedValueOnce([]);

      await expect(worker.scheduled(mockEvent, mockEnv, mockCtx)).resolves.toBeUndefined();

      // エラー側は 'Cron job failed' を記録し、問い合わせ側は最後まで実行される
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('[Error Reporter] Cron job failed'),
        expect.any(Error)
      );
      expect(sqlText(mockSql.mock.calls[1])).toContain('FROM support_inquiries');
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No pending inquiries'));
    });
  });

  // ===========================================================================
  // processErrors（errors テーブル → GitHub Issue）
  // ===========================================================================
  describe('processErrors: 未処理エラーがない場合', () => {
    it('DB から空配列が返った場合は GitHub API を呼ばない', async () => {
      mockSql.mockResolvedValueOnce([]);

      await processErrors(mockEnv);

      expect(mockSql).toHaveBeenCalledTimes(1);
      expect(sqlText(mockSql.mock.calls[0])).toContain('github_issue_created = false');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('No pending errors')
      );
    });
  });

  describe('processErrors: 新規 Issue 作成フロー', () => {
    it('未処理エラーがあり既存 Issue がない場合、新規 Issue を作成して処理済みマークする', async () => {
      const errorRecord = makeErrorRecord();

      mockSql.mockResolvedValueOnce([errorRecord]); // SELECT
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ total_count: 0, items: [] }),
      }); // GitHub search
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 42, html_url: 'https://github.com/test/42' }),
      }); // GitHub create issue
      mockSql.mockResolvedValueOnce(undefined); // UPDATE (markErrorsAsProcessed)

      await processErrors(mockEnv);

      expect(mockSql).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const createIssueCall = fetchMock.mock.calls[1];
      expect(createIssueCall[0]).toContain('/repos/testowner/testrepo/issues');
      const createBody = JSON.parse(createIssueCall[1].body);
      expect(createBody.title).toContain('[preview]');
      expect(createBody.body).toContain('Signature:');
      expect(createBody.labels).toContain('bug');
      expect(createBody.labels).toContain('auto-generated');
      expect(createBody.labels).toContain('preview');

      const updateCall = mockSql.mock.calls[1];
      expect(sqlText(updateCall)).toContain('UPDATE errors');
      expect(sqlText(updateCall)).toContain('WHERE id = ANY(');
      expect(sqlText(updateCall)).toContain('::uuid[]');
      // 補間順序: issueNumber, issueUrl, errorIds（markErrorsAsProcessed のSQL参照）
      expect(updateCall[1]).toBe(42);
      expect(updateCall[2]).toBe('https://github.com/test/42');
      expect(updateCall[3]).toEqual([errorRecord.id]);
    });
  });

  describe('processErrors: 既存 Issue へのコメント追加フロー', () => {
    it('既存 Issue がある場合はコメントを追加する', async () => {
      const errorRecord = makeErrorRecord();

      mockSql.mockResolvedValueOnce([errorRecord]);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          total_count: 1,
          items: [{ number: 10, html_url: 'https://github.com/test/10' }],
        }),
      });
      fetchMock.mockResolvedValueOnce({ ok: true });
      mockSql.mockResolvedValueOnce(undefined);

      await processErrors(mockEnv);

      const commentCall = fetchMock.mock.calls[1];
      expect(commentCall[0]).toContain('/issues/10/comments');
      expect(commentCall[1].method).toBe('POST');
    });
  });

  describe('processErrors: addCommentToIssue 失敗時', () => {
    it('コメント追加失敗時は markErrorsAsProcessed がスキップされる', async () => {
      const errorRecord = makeErrorRecord();

      mockSql.mockResolvedValueOnce([errorRecord]);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          total_count: 1,
          items: [{ number: 10, html_url: 'https://github.com/test/10' }],
        }),
      });
      fetchMock.mockResolvedValueOnce({ ok: false, status: 403 });

      await processErrors(mockEnv);

      // markErrorsAsProcessed (UPDATE) は呼ばれない（SELECT の1回のみ）
      expect(mockSql).toHaveBeenCalledTimes(1);
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

      mockSql.mockResolvedValueOnce([error1, error2]);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ total_count: 0, items: [] }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 50, html_url: 'https://github.com/test/50' }),
      });
      mockSql.mockResolvedValueOnce(undefined);

      await processErrors(mockEnv);

      // Issue は1つだけ作成される（search 1回 + create 1回、DB は select 1回 + update 1回）
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(mockSql).toHaveBeenCalledTimes(2);

      const updateCall = mockSql.mock.calls[1];
      expect(updateCall[3]).toEqual(['uuid-1', 'uuid-2']);
    });

    it('異なるメッセージのエラーは別々の Issue になる', async () => {
      const error1 = makeErrorRecord({ id: 'uuid-1', message: 'Error A' });
      const error2 = makeErrorRecord({ id: 'uuid-2', message: 'Error B' });

      mockSql.mockResolvedValueOnce([error1, error2]);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ total_count: 0, items: [] }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 51, html_url: 'https://github.com/test/51' }),
      });
      mockSql.mockResolvedValueOnce(undefined);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ total_count: 0, items: [] }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 52, html_url: 'https://github.com/test/52' }),
      });
      mockSql.mockResolvedValueOnce(undefined);

      await processErrors(mockEnv);

      // GitHub: search+create ×2 = 4回。DB: select(1) + update ×2 = 3回。
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(mockSql).toHaveBeenCalledTimes(3);
    });
  });

  describe('processErrors: MAX_NEW_ISSUES_PER_RUN 制限', () => {
    it('1回の実行で最大5件の新規 Issue しか作成しない', async () => {
      const errors = Array.from({ length: 6 }, (_, i) =>
        makeErrorRecord({ id: `uuid-${i}`, message: `Error ${i}` })
      );

      mockSql.mockResolvedValueOnce(errors);

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
          mockSql.mockResolvedValueOnce(undefined);
        }
      }

      await processErrors(mockEnv);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Max new issues limit')
      );
    });
  });

  describe('processErrors: DB エラー', () => {
    it('fetchPendingErrors が失敗した場合は例外を投げる（scheduled 側で捕捉される）', async () => {
      mockSql.mockRejectedValueOnce(new Error('connection refused'));

      await expect(processErrors(mockEnv)).rejects.toThrow(/connection refused/);
    });
  });

  describe('processErrors: production 環境のラベル', () => {
    it('production 環境のエラーには環境ラベルが付かない', async () => {
      const errorRecord = makeErrorRecord({ environment: 'production' });

      mockSql.mockResolvedValueOnce([errorRecord]);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ total_count: 0, items: [] }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 99, html_url: 'https://github.com/test/99' }),
      });
      mockSql.mockResolvedValueOnce(undefined);

      await processErrors(mockEnv);

      const createBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(createBody.labels).toEqual(['bug', 'auto-generated']);
      expect(createBody.labels).not.toContain('production');
    });
  });

  // ===========================================================================
  // processInquiries（support_inquiries テーブル → GitHub Issue）
  // ===========================================================================
  describe('processInquiries: 未処理問い合わせがない場合', () => {
    it('空配列なら GitHub API を呼ばず、FIFO・limit=10 でポーリングする', async () => {
      mockSql.mockResolvedValueOnce([]);

      await processInquiries(mockEnv);

      expect(mockSql).toHaveBeenCalledTimes(1);
      const query = sqlText(mockSql.mock.calls[0]);
      expect(query).toContain('FROM support_inquiries');
      expect(query).toContain('github_issue_created = false');
      expect(query).toContain('ORDER BY created_at ASC');
      expect(query).toContain('LIMIT');
      expect(mockSql.mock.calls[0][1]).toBe(10); // MAX_INQUIRIES_PER_RUN のバインド値
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('No pending inquiries')
      );
    });
  });

  describe('processInquiries: 新規 Issue 作成フロー', () => {
    it('既存 Issue がない場合、新規 Issue を作成して処理済みマークする', async () => {
      const inquiry = makeInquiry();

      mockSql.mockResolvedValueOnce([inquiry]);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ total_count: 0, items: [] }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 42, html_url: 'https://github.com/test/42' }),
      });
      mockSql.mockResolvedValueOnce(undefined);

      await processInquiries(mockEnv);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(mockSql).toHaveBeenCalledTimes(2);

      const createCall = fetchMock.mock.calls[1];
      expect(createCall[0]).toContain('/repos/testowner/testrepo/issues');
      expect(createCall[1].method).toBe('POST');
      const createBody = JSON.parse(createCall[1].body);
      expect(createBody.title).toContain('[問い合わせ/バグ報告]');
      expect(createBody.title).toContain('Test subject');
      expect(createBody.body).toContain('Inquiry-ID: inq-1');
      expect(createBody.body).toContain('TestUser');
      expect(createBody.labels).toContain('support-inquiry');
      expect(createBody.labels).toContain('auto-generated');

      const updateCall = mockSql.mock.calls[1];
      expect(sqlText(updateCall)).toContain('UPDATE support_inquiries');
      expect(sqlText(updateCall)).toContain('WHERE id =');
      // 補間順序: issueNumber, issueUrl, id（markInquiryProcessed のSQL参照）
      expect(updateCall[1]).toBe(42);
      expect(updateCall[2]).toBe('https://github.com/test/42');
      expect(updateCall[3]).toBe('inq-1');
    });

    it('本文中のバッククォート連より長いフェンスで囲む（フェンス脱出防止）', async () => {
      const inquiry = makeInquiry({ body: 'contains ``` triple backticks' });

      mockSql.mockResolvedValueOnce([inquiry]);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ total_count: 0, items: [] }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 1, html_url: 'https://github.com/test/1' }),
      });
      mockSql.mockResolvedValueOnce(undefined);

      await processInquiries(mockEnv);

      const createBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      // 本文の最長 ``` (3連) より長い ```` (4連) フェンスで囲まれる
      expect(createBody.body).toContain('````\ncontains ``` triple backticks\n````');
    });
  });

  describe('processInquiries: 既存 Issue が見つかった場合（冪等性）', () => {
    it('既存 Issue があれば新規作成せず、それでも処理済みマークする', async () => {
      const inquiry = makeInquiry();

      mockSql.mockResolvedValueOnce([inquiry]);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          total_count: 1,
          items: [{ number: 10, html_url: 'https://github.com/test/10' }],
        }),
      });
      mockSql.mockResolvedValueOnce(undefined);

      await processInquiries(mockEnv);

      // create を挟まないので fetch は search の1回のみ
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(mockSql).toHaveBeenCalledTimes(2);

      const updateCall = mockSql.mock.calls[1];
      expect(sqlText(updateCall)).toContain('UPDATE support_inquiries');
      expect(updateCall[1]).toBe(10);

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

      mockSql.mockResolvedValueOnce([inquiry1, inquiry2]);
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
      // inq-2: search なし → create 成功 → UPDATE 成功
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ total_count: 0, items: [] }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 99, html_url: 'https://github.com/test/99' }),
      });
      mockSql.mockResolvedValueOnce(undefined);

      await processInquiries(mockEnv);

      // SELECT(1) + inq-1[search, create-fail(fetchのみ)] + inq-2[search, create, UPDATE]
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(mockSql).toHaveBeenCalledTimes(2); // SELECT + inq-2 の UPDATE のみ（inq-1 は失敗しUPDATEに到達しない）
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to process inquiry inq-1'),
        expect.any(Error)
      );

      const lastUpdateCall = mockSql.mock.calls[1];
      expect(lastUpdateCall[3]).toBe('inq-2');
    });
  });

  // GitHub API 呼び出しヘッダの契約を固定する（githubHeaders 改変時の回帰検知）。
  // #711 C: DB アクセスは fetch を使わなくなったため、Supabase PATCH ヘッダの
  // 契約テスト（apikey/Prefer 等）は対象機能ごと削除した。
  describe('リクエストヘッダ契約', () => {
    it('GitHub POST が期待するヘッダを送る', async () => {
      const inquiry = makeInquiry();
      mockSql.mockResolvedValueOnce([inquiry]);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ total_count: 0, items: [] }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 7, html_url: 'https://github.com/test/7' }),
      });
      mockSql.mockResolvedValueOnce(undefined);

      await processInquiries(mockEnv);

      const createHeaders = fetchMock.mock.calls[1][1].headers;
      expect(createHeaders['Authorization']).toBe('Bearer gh-token');
      expect(createHeaders['Accept']).toBe('application/vnd.github+json');
      expect(createHeaders['X-GitHub-Api-Version']).toBe('2022-11-28');
      expect(createHeaders['User-Agent']).toBe('twica-error-reporter');
      expect(createHeaders['Content-Type']).toBe('application/json');
    });
  });

  describe('processInquiries: 入力の無害化とカテゴリ', () => {
    it('未知のカテゴリはそのまま表示される', async () => {
      const inquiry = makeInquiry({ category: 'weird' });
      mockSql.mockResolvedValueOnce([inquiry]);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ total_count: 0, items: [] }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 1, html_url: 'https://github.com/test/1' }),
      });
      mockSql.mockResolvedValueOnce(undefined);

      await processInquiries(mockEnv);

      const createBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(createBody.title).toContain('[問い合わせ/weird]');
    });

    it('件名・表示名は inlineCode で無害化され、改行や markdown 注入を防ぐ', async () => {
      const inquiry = makeInquiry({
        twitch_display_name: '@everyone',
        subject: 'line1\n# fake heading',
      });
      mockSql.mockResolvedValueOnce([inquiry]);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ total_count: 0, items: [] }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 1, html_url: 'https://github.com/test/1' }),
      });
      mockSql.mockResolvedValueOnce(undefined);

      await processInquiries(mockEnv);

      const createBody = JSON.parse(fetchMock.mock.calls[1][1].body);
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
      mockSql.mockResolvedValueOnce([inquiry]);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ total_count: 0, items: [] }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 1, html_url: 'https://github.com/test/1' }),
      });
      mockSql.mockResolvedValueOnce(undefined);

      await processInquiries(mockEnv);

      const createBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(createBody.body).toContain('`weird # injected heading`');
      expect(createBody.body).not.toContain('\nweird\n# injected heading');
    });
  });

  describe('processInquiries: 冪等性の保険', () => {
    it('新規作成に成功しても処理済みマーク(UPDATE)が失敗した場合は例外が伝播する', async () => {
      // フラグが false のまま残るため、次回実行時に search で拾われて重複作成が
      // 防がれる想定（本命の冪等性）。ここでは UPDATE 失敗時に例外が正しく
      // 伝播し、個別 try/catch で処理が打ち切られることのみ検証する。
      const inquiry = makeInquiry();
      mockSql.mockResolvedValueOnce([inquiry]);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ total_count: 0, items: [] }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 5, html_url: 'https://github.com/test/5' }),
      });
      // UPDATE 失敗
      mockSql.mockRejectedValueOnce(new Error('db error'));

      await processInquiries(mockEnv);

      expect(mockSql).toHaveBeenCalledTimes(2);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to process inquiry inq-1'),
        expect.any(Error)
      );
    });

    it('GitHub Search API 自体が失敗した場合は既存なし扱いで新規作成に進む', async () => {
      // searchIssue は API 失敗時に例外を投げず null を返す設計（本命の冪等性は
      // github_issue_created フラグであり、search はあくまで補助のため）。
      const inquiry = makeInquiry();
      mockSql.mockResolvedValueOnce([inquiry]);
      // search 失敗（403 = レート制限等）
      fetchMock.mockResolvedValueOnce({ ok: false, status: 403 });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 8, html_url: 'https://github.com/test/8' }),
      });
      mockSql.mockResolvedValueOnce(undefined);

      await processInquiries(mockEnv);

      // search 失敗後も create → update まで進む
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const createCall = fetchMock.mock.calls[1];
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

      mockSql.mockResolvedValueOnce([]); // errors
      mockSql.mockResolvedValueOnce([]); // inquiries
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      }); // list
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ number: 200, html_url: 'https://github.com/test/200' }),
      }); // create

      await worker.scheduled(mockEvent, env, mockCtx);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(mockSql).toHaveBeenCalledTimes(2);
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Created issue #200')
      );
    });

    it('scheduled() 経由で processEventSubParkBacklog が失敗しても他の処理は影響を受けない', async () => {
      const keys = Array.from({ length: 10 }, (_, i) => parkedKey(1, `msg-${i}`));
      const env = makeKvEnv(keys);

      mockSql.mockResolvedValueOnce([]); // errors
      mockSql.mockResolvedValueOnce([]); // inquiries
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
  // processEventSubParkAutoDrain（Issue #695 KVベース部分改善の2項目目:
  // EventSub 退避 backlog 自動ドレイン）
  //
  // processEventSubParkBacklog と異なり RATE_LIMIT_KV を直接読まず、
  // GET /api/maintenance-status と POST /api/admin/eventsub-replay を
  // HTTP 経由で叩く（prod/preview 両ターゲット）。「最古エントリの経過時間」で
  // fake timers を使う点は processEventSubParkBacklog のテストと同じ。
  // ===========================================================================
  describe('processEventSubParkAutoDrain', () => {
    const FIXED_NOW = new Date('2026-01-01T12:00:00.000Z');

    const drainEnv = {
      ...mockEnv,
      APP_BASE_URL_PROD: 'https://prod.example.com',
      APP_BASE_URL_PREVIEW: 'https://preview.example.com',
      EVENTSUB_REPLAY_SECRET_PROD: 'prod-secret',
      EVENTSUB_REPLAY_SECRET_PREVIEW: 'preview-secret',
    };

    /** age分だけ FIXED_NOW より過去の ISO8601 文字列を返す。 */
    const agoIso = (minutesAgo: number) =>
      new Date(FIXED_NOW.getTime() - minutesAgo * 60_000).toISOString();

    const emptyCounts = {
      succeeded: 0,
      skipped: 0,
      failed: 0,
      unknownType: 0,
      invalidPayload: 0,
      total: 0,
    };

    /** dry-run peek レスポンス（listParkedEventSubNotifications 相当）を組み立てる。 */
    const peekResponse = (receivedAtList: string[]) => ({
      ok: true,
      json: () =>
        Promise.resolve({
          dryRun: true,
          listComplete: true,
          results: receivedAtList.map((receivedAt, i) => ({
            key: `maintenance:eventsub:${receivedAt}:msg-${i}`,
            messageId: `msg-${i}`,
            subscriptionType: 'channel.channel_points_custom_reward_redemption.add',
            receivedAt,
            outcome: 'dry-run',
          })),
          counts: emptyCounts,
        }),
    });

    /** maintenance-status レスポンスを組み立てる。 */
    const statusResponse = (mode: string) => ({
      ok: true,
      json: () => Promise.resolve({ mode }),
    });

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(FIXED_NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('baseUrl が未設定のターゲットは warn ログのみで fetch しない', async () => {
      const env = { ...mockEnv }; // APP_BASE_URL_PROD/PREVIEW ともに無し

      await processEventSubParkAutoDrain(env);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Missing base URL for production')
      );
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Missing base URL for preview')
      );
    });

    it('replay secret が未設定のターゲットは maintenance-status すら呼ばず warn ログのみ', async () => {
      const env = {
        ...mockEnv,
        APP_BASE_URL_PROD: 'https://prod.example.com',
        APP_BASE_URL_PREVIEW: 'https://preview.example.com',
        // secret 両方未設定
      };

      await processEventSubParkAutoDrain(env);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Missing replay secret for production')
      );
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Missing replay secret for preview')
      );
    });

    it('maintenance mode が off 以外なら eventsub-replay を呼ばずスキップする', async () => {
      fetchMock.mockResolvedValueOnce(statusResponse('read-only')); // prod status
      fetchMock.mockResolvedValueOnce(statusResponse('read-only')); // preview status

      await processEventSubParkAutoDrain(drainEnv);

      // maintenance-status の GET のみ（POST /eventsub-replay は呼ばれない）
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toBe('https://prod.example.com/api/maintenance-status');
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("production: maintenance mode is 'read-only' (not 'off'), skipping")
      );
    });

    it('maintenance-status が非2xxを返した場合はエラーログを出しスキップする（off と決め打たない）', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 503, text: () => Promise.resolve('unavailable') });
      fetchMock.mockResolvedValueOnce(statusResponse('off')); // preview は正常
      fetchMock.mockResolvedValueOnce(peekResponse([])); // preview peek: backlog無し

      await processEventSubParkAutoDrain(drainEnv);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('maintenance-status returned 503 for https://prod.example.com')
      );
      // production はここで打ち切り（eventsub-replay へは進まない）だが、
      // preview は独立して処理が続く。
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('backlog が0件なら eventsub-replay 実行(dryRun:false)は呼ばれない', async () => {
      fetchMock.mockResolvedValueOnce(statusResponse('off'));
      fetchMock.mockResolvedValueOnce(peekResponse([])); // peek: 0件
      fetchMock.mockResolvedValueOnce(statusResponse('off'));
      fetchMock.mockResolvedValueOnce(peekResponse([]));

      await processEventSubParkAutoDrain(drainEnv);

      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('production: no parked notifications, nothing to drain')
      );
    });

    it('最古エントリの経過時間が10分未満なら eventual consistency ガードによりスキップする', async () => {
      fetchMock.mockResolvedValueOnce(statusResponse('off'));
      fetchMock.mockResolvedValueOnce(peekResponse([agoIso(5)])); // 5分前（閾値10分未満）
      fetchMock.mockResolvedValueOnce(statusResponse('off'));
      fetchMock.mockResolvedValueOnce(peekResponse([agoIso(5)]));

      await processEventSubParkAutoDrain(drainEnv);

      // status + peek のみ（計4回）。実ドレイン(POST dryRun:false)は呼ばれない。
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('production: oldest entry age 5min is below threshold (10min)')
      );
    });

    it('最古エントリの経過時間が10分以上なら1バッチのみ実ドレインし結果をログする', async () => {
      fetchMock.mockResolvedValueOnce(statusResponse('off')); // prod status
      fetchMock.mockResolvedValueOnce(peekResponse([agoIso(15)])); // prod peek: 15分前
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            dryRun: false,
            listComplete: true,
            results: [],
            counts: { succeeded: 3, skipped: 1, failed: 0, unknownType: 0, invalidPayload: 0, total: 4 },
          }),
      }); // prod 実ドレイン
      fetchMock.mockResolvedValueOnce(statusResponse('off')); // preview status
      fetchMock.mockResolvedValueOnce(peekResponse([])); // preview peek: 0件

      await processEventSubParkAutoDrain(drainEnv);

      expect(fetchMock).toHaveBeenCalledTimes(5);

      // 実ドレイン呼び出しのリクエストボディを検証(limit=20固定、dryRun:false)
      const drainCall = fetchMock.mock.calls[2];
      expect(drainCall[0]).toBe('https://prod.example.com/api/admin/eventsub-replay');
      const drainBody = JSON.parse(drainCall[1].body);
      expect(drainBody).toEqual({ dryRun: false, limit: 20 });
      expect(drainCall[1].headers['X-Replay-Secret']).toBe('prod-secret');

      // peek 呼び出しは limit=1 の dry-run
      const peekCall = fetchMock.mock.calls[1];
      const peekBody = JSON.parse(peekCall[1].body);
      expect(peekBody).toEqual({ dryRun: true, limit: 1 });

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining(
          'production: batch drained - succeeded=3 skipped=1 failed=0 unknownType=0 invalidPayload=0 total=4 listComplete=true'
        )
      );
    });

    it('実ドレインが非2xxを返してもエラーログのみで例外を投げず、他ターゲットの処理は続く', async () => {
      fetchMock.mockResolvedValueOnce(statusResponse('off'));
      fetchMock.mockResolvedValueOnce(peekResponse([agoIso(15)]));
      fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve('boom') }); // prod 実ドレイン失敗
      fetchMock.mockResolvedValueOnce(statusResponse('off'));
      fetchMock.mockResolvedValueOnce(peekResponse([])); // preview は正常続行

      await expect(processEventSubParkAutoDrain(drainEnv)).resolves.toBeUndefined();

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('eventsub-replay returned 500 for https://prod.example.com: boom')
      );
      // preview 側の呼び出しまで到達している(独立性の確認)
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('preview: no parked notifications, nothing to drain')
      );
    });

    it('fetch がネットワークエラーで reject してもエラーログのみで他ターゲットは続行する', async () => {
      fetchMock.mockRejectedValueOnce(new Error('network down')); // prod status で例外
      fetchMock.mockResolvedValueOnce(statusResponse('off')); // preview status
      fetchMock.mockResolvedValueOnce(peekResponse([]));

      await expect(processEventSubParkAutoDrain(drainEnv)).resolves.toBeUndefined();

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('failed to fetch maintenance-status for https://prod.example.com'),
        expect.any(Error)
      );
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('末尾スラッシュ付きの baseUrl でも二重スラッシュにならない', async () => {
      const env = {
        ...mockEnv,
        APP_BASE_URL_PROD: 'https://prod.example.com/',
        APP_BASE_URL_PREVIEW: undefined,
        EVENTSUB_REPLAY_SECRET_PROD: 'prod-secret',
        EVENTSUB_REPLAY_SECRET_PREVIEW: undefined,
      };
      fetchMock.mockResolvedValueOnce(statusResponse('off'));
      fetchMock.mockResolvedValueOnce(peekResponse([]));

      await processEventSubParkAutoDrain(env);

      expect(fetchMock.mock.calls[0][0]).toBe('https://prod.example.com/api/maintenance-status');
    });
  });

  // ===========================================================================
  // scheduled(): event.cron による分岐（自動ドレイン専用トリガー vs 既存3処理）
  // ===========================================================================
  describe('scheduled(): cron トリガーによる分岐', () => {
    it('event.cron が EVENTSUB_AUTO_DRAIN_CRON の場合は自動ドレインのみ実行し、既存3処理は実行しない', async () => {
      const drainEvent = { cron: EVENTSUB_AUTO_DRAIN_CRON } as ScheduledController;
      const env = {
        ...mockEnv,
        APP_BASE_URL_PROD: 'https://prod.example.com',
        APP_BASE_URL_PREVIEW: undefined,
        EVENTSUB_REPLAY_SECRET_PROD: 'prod-secret',
        EVENTSUB_REPLAY_SECRET_PREVIEW: undefined,
      };
      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ mode: 'off' }) });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            dryRun: true,
            listComplete: true,
            results: [],
            counts: { succeeded: 0, skipped: 0, failed: 0, unknownType: 0, invalidPayload: 0, total: 0 },
          }),
      });

      await worker.scheduled(drainEvent, env, mockCtx);

      // maintenance-status + peek の2回のみ（errors/inquiries/backlog監視 の
      // DB/GitHub 呼び出しは一切発生しない）
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(mockSql).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls[0][0]).toContain('/api/maintenance-status');
      expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('No pending errors'));
      expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('No pending inquiries'));
    });

    it('event.cron が既存トリガー(*/5 * * * *)の場合は従来どおり既存3処理のみ実行し、自動ドレインは実行しない', async () => {
      const normalEvent = { cron: '*/5 * * * *' } as ScheduledController;

      mockSql.mockResolvedValueOnce([]); // errors
      mockSql.mockResolvedValueOnce([]); // inquiries
      // mockEnv には RATE_LIMIT_KV も APP_BASE_URL_* も無いため
      // backlog監視は早期return、自動ドレインは呼ばれていればwarnログが出るはず

      await worker.scheduled(normalEvent, mockEnv, mockCtx);

      expect(mockSql).toHaveBeenCalledTimes(2);
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No pending errors'));
      expect(console.log).not.toHaveBeenCalledWith(
        expect.stringContaining('[EventSub Auto Drain] Started')
      );
    });

    it('event.cron が未設定(テスト用の空イベント等)の場合も既存3処理が実行される(後方互換)', async () => {
      // mockEvent = {} as ScheduledController は cron が undefined。
      // EVENTSUB_AUTO_DRAIN_CRON と一致しないため、既存トリガーと同じ分岐に落ちる。
      mockSql.mockResolvedValueOnce([]);
      mockSql.mockResolvedValueOnce([]);

      await worker.scheduled(mockEvent, mockEnv, mockCtx);

      expect(mockSql).toHaveBeenCalledTimes(2);
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No pending errors'));
    });

    it('EVENTSUB_AUTO_DRAIN_CRON が wrangler.toml の [triggers] crons に実在する(ドリフト検知)', () => {
      // index.ts の EVENTSUB_AUTO_DRAIN_CRON と wrangler.toml の crons 配列は
      // コメントでの相互参照のみに頼っており、片方だけ変更されると自動ドレインが
      // 黙って発火しなくなる（かつ変更後トリガーが既存3処理をその頻度で
      // 再実行してしまう二重の害がある、Fableレビュー Minor指摘）。
      // TOML全体をパースする専用パッケージは導入せず、crons行を正規表現で
      // 抽出するだけの軽量な検証に留める（YAGNI）。
      const wranglerToml = readFileSync(
        resolve(__dirname, '../../workers/error-reporter/wrangler.toml'),
        'utf-8'
      );
      const cronsLineMatch = wranglerToml.match(/^crons\s*=\s*\[(.+)\]/m);
      expect(cronsLineMatch).not.toBeNull();
      const crons = (cronsLineMatch?.[1] ?? '')
        .split(',')
        .map((s) => s.trim().replace(/^"(.*)"$/, '$1'))
        .filter(Boolean);
      expect(crons).toContain(EVENTSUB_AUTO_DRAIN_CRON);
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
