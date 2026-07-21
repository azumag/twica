import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  reportError,
  reportApiError,
  reportAuthError,
  reportGachaError,
  reportRealtimeError,
  reportSecurityError,
  logErrorFromLogger,
} from '@/lib/sentry/error-handler';
import { getDb } from '@/lib/db/client';

// Supabase admin のモック
const mockInsert = vi.fn().mockResolvedValue({ error: null });
const mockFrom = vi.fn().mockReturnValue({ insert: mockInsert });

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom }),
}));

vi.mock('@/lib/db/client', () => ({
  getDb: vi.fn(),
}));

const mockPgValues = vi.fn().mockResolvedValue(undefined);
const mockPgInsert = vi.fn().mockReturnValue({ values: mockPgValues });

/**
 * 動的 import を含む非同期経路が対象 mock へ到達するまで、タイマーに依存せず待つ。
 * 上限を設けることで、実装が mock を呼ばない回帰時にもテストがハングしない。
 */
async function waitForMockCalls(mock: ReturnType<typeof vi.fn>, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (mock.mock.calls.length >= count) return;
    await Promise.resolve();
  }
  throw new Error(`Expected mock to be called ${count} time(s), received ${mock.mock.calls.length}`);
}

describe('sentry/error-handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('DB_DRIVER', 'postgrest');
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    // console 出力を抑制
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(getDb).mockResolvedValue({
      db: { insert: mockPgInsert } as never,
      sql: {} as never,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('全 report 関数が Promise を返す', () => {
    it('reportError は Promise を返す', async () => {
      const result = reportError(new Error('test'));
      expect(result).toBeInstanceOf(Promise);
      await result;
    });

    it('reportApiError は Promise を返す', async () => {
      const result = reportApiError('/api/test', 'GET', new Error('test'));
      expect(result).toBeInstanceOf(Promise);
      await result;
    });

    it('reportAuthError は Promise を返す', async () => {
      const result = reportAuthError(new Error('test'), { provider: 'twitch' });
      expect(result).toBeInstanceOf(Promise);
      await result;
    });

    it('reportGachaError は Promise を返す', async () => {
      const result = reportGachaError(new Error('test'), { streamerId: '123' });
      expect(result).toBeInstanceOf(Promise);
      await result;
    });

    it('reportRealtimeError は Promise を返す', async () => {
      const result = reportRealtimeError(new Error('test'), { action: 'subscribe' });
      expect(result).toBeInstanceOf(Promise);
      await result;
    });

    it('reportSecurityError は Promise を返す', async () => {
      const result = reportSecurityError(new Error('test'), { action: 'csrf' });
      expect(result).toBeInstanceOf(Promise);
      await result;
    });
  });

  describe('Supabase へのエラーログ記録', () => {
    it('Error オブジェクトの場合、message と stack を記録する', async () => {
      const error = new Error('test error');
      await reportError(error, { key: 'value' });

      expect(mockFrom).toHaveBeenCalledWith('errors');
      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          error_type: '[Error]',
          message: 'test error',
          context: { key: 'value' },
        })
      );
      // stack_trace が null でないこと
      const insertArg = mockInsert.mock.calls[0][0];
      expect(insertArg.stack_trace).toBeTruthy();
    });

    it('非 Error の文字列は extractErrorMessage 経由でそのまま記録する', async () => {
      await reportError('string error');

      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          error_type: '[Warning]',
          message: 'string error',
          stack_trace: null,
        })
      );
    });

    it('reportApiError はエンドポイント情報を context に含める', async () => {
      await reportApiError('/api/users', 'POST', new Error('fail'), { extra: 'data' });

      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          error_type: '[API Error]',
          message: 'POST /api/users: fail',
          context: { endpoint: '/api/users', method: 'POST', extra: 'data' },
        })
      );
    });
  });

  describe('PG 直結へのエラーログ記録 (#711 C)', () => {
    it('DB_DRIVER=pg では Drizzle insert を使い PostgREST を呼ばない', async () => {
      vi.stubEnv('DB_DRIVER', 'pg');
      vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://twica-preview.example');

      await reportError(new Error('pg error'), {
        token: 'secret',
        safe: 'visible',
      });

      expect(getDb).toHaveBeenCalledTimes(1);
      expect(mockPgInsert).toHaveBeenCalledTimes(1);
      expect(mockPgValues).toHaveBeenCalledWith(expect.objectContaining({
        error_type: '[Error]',
        message: 'pg error',
        context: { token: '[REDACTED]', safe: 'visible' },
        environment: 'preview',
      }));
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it('DB_DRIVER=pg-readではwriteを従来のPostgREST経路に留める', async () => {
      vi.stubEnv('DB_DRIVER', 'pg-read');

      await reportError(new Error('read-only rollout'));

      expect(getDb).not.toHaveBeenCalled();
      expect(mockPgInsert).not.toHaveBeenCalled();
      expect(mockFrom).toHaveBeenCalledWith('errors');
      expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({
        message: 'read-only rollout',
      }));
    });

    it('PG insert失敗は呼び出し元へ伝播せずconsole警告へフォールバックする', async () => {
      vi.stubEnv('DB_DRIVER', 'pg');
      mockPgValues.mockRejectedValueOnce(new Error('database unavailable'));

      await expect(reportError(new Error('original error'))).resolves.toBeUndefined();

      expect(console.warn).toHaveBeenCalledWith(
        '[Error Tracking] Failed to persist error:',
        expect.objectContaining({ message: 'database unavailable' }),
      );
    });

    it('失敗後も次のエラーは記録できる', async () => {
      vi.stubEnv('DB_DRIVER', 'pg');
      mockPgValues
        .mockRejectedValueOnce(new Error('temporary failure'))
        .mockResolvedValueOnce(undefined);

      await reportError(new Error('first'));
      await reportError(new Error('second'));

      expect(mockPgValues).toHaveBeenCalledTimes(2);
      expect(mockPgValues.mock.calls[1][0]).toEqual(expect.objectContaining({ message: 'second' }));
    });

    it('別requestで並行発生した同一内容のエラーをどちらも記録する', async () => {
      vi.stubEnv('DB_DRIVER', 'pg');
      let releaseInsert!: () => void;
      mockPgValues.mockReturnValueOnce(new Promise<void>((resolve) => {
        releaseInsert = resolve;
      }));

      const first = reportError('same incident');
      await waitForMockCalls(mockPgValues, 1);
      const concurrent = reportError('same incident');
      await waitForMockCalls(mockPgValues, 2);

      expect(mockPgValues).toHaveBeenCalledTimes(2);

      releaseInsert();
      await Promise.all([first, concurrent]);
    });
  });

  describe('reportRealtimeError の期待されるステータス抑制', () => {
    it('isExpected: true の場合はログもSupabase記録もスキップする', async () => {
      await reportRealtimeError(new Error('closed'), {
        action: 'subscribe',
        isExpected: true,
      });

      expect(mockFrom).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();
    });

    it.each(['CLOSED', 'TIMED_OUT', 'CHANNEL_ERROR'])(
      'status=%s の場合はスキップする',
      async (status) => {
        await reportRealtimeError(new Error('expected'), {
          action: 'subscribe',
          status,
        });

        expect(mockFrom).not.toHaveBeenCalled();
      }
    );

    it('予期しないステータスの場合は記録する', async () => {
      await reportRealtimeError(new Error('unexpected'), {
        action: 'subscribe',
        status: 'UNKNOWN_STATUS',
      });

      expect(mockFrom).toHaveBeenCalledWith('errors');
    });
  });

  describe('機密情報のサニタイズ', () => {
    it('SENSITIVE_KEYS に一致するキーは [REDACTED] になる', async () => {
      await reportError(new Error('test'), {
        password: 'secret123',
        token: 'abc',
        username: 'public',
        access_token: 'tok',
        refresh_token: 'ref',
        api_key: 'key',
        email: 'user@example.com',
        safeName: 'visible',
      });

      const insertArg = mockInsert.mock.calls[0][0];
      expect(insertArg.context.password).toBe('[REDACTED]');
      expect(insertArg.context.token).toBe('[REDACTED]');
      expect(insertArg.context.access_token).toBe('[REDACTED]');
      expect(insertArg.context.refresh_token).toBe('[REDACTED]');
      expect(insertArg.context.api_key).toBe('[REDACTED]');
      expect(insertArg.context.username).toBe('[REDACTED]');
      expect(insertArg.context.email).toBe('[REDACTED]');
      expect(insertArg.context.safeName).toBe('visible');
    });

    it('追加の SENSITIVE_KEYS (session_id, csrf_token 等) も除外される', async () => {
      await reportError(new Error('test'), {
        session_id: 'sess_abc',
        csrf_token: 'csrf123',
        otp: '123456',
        auth_code: 'code',
        safeProp: 'visible',
      });

      const insertArg = mockInsert.mock.calls[0][0];
      expect(insertArg.context.session_id).toBe('[REDACTED]');
      expect(insertArg.context.csrf_token).toBe('[REDACTED]');
      expect(insertArg.context.otp).toBe('[REDACTED]');
      expect(insertArg.context.auth_code).toBe('[REDACTED]');
      expect(insertArg.context.safeProp).toBe('visible');
    });

    it('ネストしたオブジェクトも再帰的にサニタイズする', async () => {
      await reportError(new Error('test'), {
        nested: { password: 'secret', safe: 'ok' },
      });

      const insertArg = mockInsert.mock.calls[0][0];
      expect(insertArg.context.nested.password).toBe('[REDACTED]');
      expect(insertArg.context.nested.safe).toBe('ok');
    });

    it('配列内のオブジェクトもサニタイズする', async () => {
      await reportError(new Error('test'), {
        items: [{ userId: 'abc', name: 'test' }],
      });

      const insertArg = mockInsert.mock.calls[0][0];
      expect(insertArg.context.items[0].userId).toBe('[REDACTED]');
      expect(insertArg.context.items[0].name).toBe('test');
    });

    it('複合キー（broadcasterUserId 等）は完全一致キーでマスクしない', async () => {
      await reportError(new Error('test'), {
        userId: 'should-be-redacted',
        broadcasterUserId: 'visible-for-debug',
        twitchUsername: 'visible-for-debug',
        username: 'should-be-redacted',
      });

      const insertArg = mockInsert.mock.calls[0][0];
      // 完全一致: userId, username はマスク
      expect(insertArg.context.userId).toBe('[REDACTED]');
      expect(insertArg.context.username).toBe('[REDACTED]');
      // 複合キー: broadcasterUserId, twitchUsername はデバッグ用に保持
      expect(insertArg.context.broadcasterUserId).toBe('visible-for-debug');
      expect(insertArg.context.twitchUsername).toBe('visible-for-debug');
    });

    // Issue #401: Supabase 経路だけでなく console 経路にも同じマスキングを適用する
    it('console 出力でも context のセンシティブキーは [REDACTED] になる', async () => {
      const consoleErrorSpy = vi.mocked(console.error);
      await reportError(new Error('boom'), {
        access_token: 'tk',
        twitchUserId: '123',
      });

      // console.error 呼び出しのうち、最後の引数が sanitized context オブジェクトになっている
      const lastCall = consoleErrorSpy.mock.calls.at(-1);
      const consoleContext = lastCall?.[2];
      expect(consoleContext).toEqual({
        access_token: '[REDACTED]',
        twitchUserId: '123',
      });
    });

    it('reportApiError も console 出力で additionalContext をマスクする', async () => {
      const consoleErrorSpy = vi.mocked(console.error);
      await reportApiError('/x', 'POST', new Error('e'), {
        cookie: 'sid=abc',
        endpoint_alias: 'X',
      });

      const lastCall = consoleErrorSpy.mock.calls.at(-1);
      const consoleContext = lastCall?.[2];
      expect(consoleContext).toEqual({
        cookie: '[REDACTED]',
        endpoint_alias: 'X',
      });
    });

    it('reportAuthError も console 出力で context をマスクする', async () => {
      const consoleErrorSpy = vi.mocked(console.error);
      await reportAuthError(new Error('auth'), {
        provider: 'twitch',
        action: 'callback',
        userId: 'should-be-redacted',
      });

      const lastCall = consoleErrorSpy.mock.calls.at(-1);
      const consoleContext = lastCall?.[2];
      expect(consoleContext).toMatchObject({
        provider: 'twitch',
        action: 'callback',
        userId: '[REDACTED]',
      });
    });
  });

  describe('プレーンオブジェクト型エラーの処理 (Issue #262)', () => {
    it('PostgrestError 形式のオブジェクトから message を抽出する', async () => {
      const postgrestError = { code: '23505', message: 'duplicate key value', details: null, hint: null };
      await reportError(postgrestError);

      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          error_type: '[Warning]',
          message: 'duplicate key value',
          stack_trace: null,
        })
      );
    });

    it('message プロパティがないオブジェクトは JSON.stringify でフォールバックする', async () => {
      const unknownObj = { code: 500, detail: 'something went wrong' };
      await reportError(unknownObj);

      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          error_type: '[Warning]',
          message: JSON.stringify(unknownObj),
          stack_trace: null,
        })
      );
    });

    it('reportApiError でもプレーンオブジェクトの message を抽出する', async () => {
      const postgrestError = { code: '42P01', message: 'relation does not exist', details: null, hint: null };
      await reportApiError('/api/streamers', 'POST', postgrestError);

      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          error_type: '[API Error]',
          message: 'POST /api/streamers: relation does not exist',
        })
      );
    });

    it('null が渡された場合は "null" として記録する', async () => {
      await reportError(null);

      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'null',
        })
      );
    });

    it('undefined が渡された場合は "undefined" として記録する', async () => {
      await reportError(undefined);

      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'undefined',
        })
      );
    });

    it('循環参照オブジェクトは "[Circular]" マーカー付きで記録する', async () => {
      const circular: Record<string, unknown> = { name: 'test' };
      circular.self = circular;
      await reportError(circular);

      const insertArg = mockInsert.mock.calls[0][0];
      expect(insertArg.message).toContain('"name":"test"');
      expect(insertArg.message).toContain('[Circular]');
    });

    it('JSON.stringify フォールバック時に機密情報キーは除外される', async () => {
      const objWithSecret = { code: 500, token: 'secret-value', detail: 'fail' };
      await reportError(objWithSecret);

      const insertArg = mockInsert.mock.calls[0][0];
      expect(insertArg.message).not.toContain('secret-value');
      expect(insertArg.message).toContain('[REDACTED]');
      expect(insertArg.message).toContain('"detail":"fail"');
    });

    it('message プロパティが文字列でないオブジェクトは JSON.stringify でフォールバックする', async () => {
      const objWithNumericMessage = { message: 42, detail: 'info' };
      await reportError(objWithNumericMessage);

      const insertArg = mockInsert.mock.calls[0][0];
      expect(insertArg.message).toContain('"message":42');
      expect(insertArg.message).toContain('"detail":"info"');
    });
  });

  describe('Supabase 記録失敗時のグレースフルデグラデーション', () => {
    it('Supabase エラーでも例外を投げない', async () => {
      mockInsert.mockRejectedValueOnce(new Error('Supabase down'));

      // 例外が投げられないことを確認
      await expect(reportError(new Error('test'))).resolves.toBeUndefined();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('[Error Tracking]'),
        expect.any(Error)
      );
    });
  });

  describe('メッセージ・スタックトレースの切り詰め', () => {
    it('10000文字を超えるメッセージは切り詰められる', async () => {
      const longMessage = 'a'.repeat(20000);
      await reportError(new Error(longMessage));

      const insertArg = mockInsert.mock.calls[0][0];
      expect(insertArg.message.length).toBe(10000);
    });
  });

  describe('logErrorFromLogger — logger.error からの Supabase 報告', () => {
    it('Error オブジェクトを args から抽出して記録する', async () => {
      const error = new Error('db connection failed');
      await logErrorFromLogger('Query error:', [error]);

      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          error_type: '[Error]',
          message: 'Query error: db connection failed',
        })
      );
      const insertArg = mockInsert.mock.calls[0][0];
      expect(insertArg.stack_trace).toBeTruthy();
    });

    it('{ error: Error } パターンからエラーを抽出する', async () => {
      const error = new Error('token expired');
      await logErrorFromLogger('Auth failed:', [{ error, userId: 'u1' }]);

      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          error_type: '[Error]',
          message: 'Auth failed: token expired',
        })
      );
      const insertArg = mockInsert.mock.calls[0][0];
      expect(insertArg.stack_trace).toBeTruthy();
    });

    it('{ error: PostgrestError } パターンからメッセージを抽出する', async () => {
      const postgrestError = { code: '23505', message: 'duplicate key', details: null, hint: null };
      await logErrorFromLogger('Insert failed:', [{ error: postgrestError }]);

      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Insert failed: duplicate key',
        })
      );
    });

    it('PostgrestError が直接 args に渡された場合もメッセージを抽出する', async () => {
      const postgrestError = { code: '23505', message: 'duplicate key', details: null, hint: null };
      await logErrorFromLogger('Insert failed:', [postgrestError]);

      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Insert failed: duplicate key',
        })
      );
    });

    it('message が空文字列のオブジェクトは errorDetail に設定されない', async () => {
      await logErrorFromLogger('Insert failed:', [{ code: '23505', message: '' }]);

      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Insert failed:',
        })
      );
    });

    it('error と message 両方あるオブジェクトは error が優先される', async () => {
      const inner = { code: '23505', message: 'from error key', details: null, hint: null };
      await logErrorFromLogger('Failed:', [{ error: inner, message: 'from top level' }]);

      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Failed: from error key',
        })
      );
    });

    it('複数の message 持ちオブジェクトが渡された場合、最初のものが使用される', async () => {
      await logErrorFromLogger('Multi:', [{ message: 'first' }, { message: 'second' }]);

      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Multi: first',
        })
      );
    });

    it('Error がない場合はメッセージのみ記録する', async () => {
      await logErrorFromLogger('Something went wrong', [{ status: 500 }]);

      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          error_type: '[Error]',
          message: 'Something went wrong',
          stack_trace: null,
        })
      );
    });

    it('context オブジェクトを Supabase に渡す', async () => {
      await logErrorFromLogger('Failed:', [new Error('oops'), { endpoint: '/api/test' }]);

      const insertArg = mockInsert.mock.calls[0][0];
      expect(insertArg.context.endpoint).toBe('/api/test');
    });

    it('Supabase 報告失敗でも例外を投げない', async () => {
      mockInsert.mockRejectedValueOnce(new Error('Supabase down'));
      await expect(logErrorFromLogger('test', [new Error('e')])).resolves.toBeUndefined();
    });

    it('複数の Error が渡された場合は最初のものが使用される（原因エラー優先）', async () => {
      const error1 = new Error('first error');
      const error2 = new Error('second error');
      await logErrorFromLogger('Multiple:', [error1, error2]);

      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Multiple: first error',
        })
      );
    });

    it('args が空の場合はメッセージのみ記録する', async () => {
      await logErrorFromLogger('No args', []);

      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'No args',
          stack_trace: null,
        })
      );
    });
  });
});
