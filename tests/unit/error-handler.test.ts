import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleApiError, handleDatabaseError, handleBlobError } from '@/lib/error-handler';
import { logErrorFromLogger } from '@/lib/sentry/error-handler';

// sentry/error-handler のモック（logErrorFromLogger を error-handler.ts が直接使用する）
vi.mock('@/lib/sentry/error-handler', () => ({
  logErrorFromLogger: vi.fn().mockResolvedValue(undefined),
}));

describe('error-handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleApiError', () => {
    it('Promise<NextResponse> を返す', async () => {
      const result = handleApiError(new Error('fail'), 'test context');
      expect(result).toBeInstanceOf(Promise);

      const response = await result;
      expect(response.status).toBe(500);
    });

    it('500 ステータスと INTERNAL_ERROR メッセージを返す', async () => {
      const response = await handleApiError(new Error('fail'), 'test');
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBeTruthy();
    });

    // Issue #653/#670: TwitchTokenError(REFRESH_FAILED)のような、API境界で
    // 診断summaryを付与したいケース向け。handleBlobErrorと同じadditionalInfo契約。
    it('additionalInfo が logErrorFromLogger に正しく渡される', async () => {
      const additionalInfo = { refreshStatus: 401, refreshErrorKind: 'http' };
      await handleApiError(new Error('fail'), 'test context', additionalInfo);

      expect(logErrorFromLogger).toHaveBeenCalledWith(
        'test context:',
        [expect.any(Error), additionalInfo]
      );
    });

    it('additionalInfo が未指定の場合は error のみ渡される(既存呼び出し元との後方互換)', async () => {
      await handleApiError(new Error('fail'), 'test context');

      expect(logErrorFromLogger).toHaveBeenCalledWith(
        'test context:',
        [expect.any(Error)]
      );
    });
  });

  describe('handleDatabaseError', () => {
    it('Promise<NextResponse> を返す', async () => {
      const result = handleDatabaseError(new Error('db fail'), 'db context');
      expect(result).toBeInstanceOf(Promise);

      const response = await result;
      expect(response.status).toBe(500);
    });

    it('500 ステータスと Database error メッセージを返す', async () => {
      const response = await handleDatabaseError(new Error('db fail'), 'test');
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Database error');
    });
  });

  describe('handleBlobError', () => {
    it('クォータ超過エラーで 507 を返す', async () => {
      const response = await handleBlobError(new Error('quota exceeded'), 'blob');
      expect(response.status).toBe(507);

      const body = await response.json();
      expect(body.error).toBe('Storage quota exceeded');
    });

    it('認証エラーで 503 を返す', async () => {
      const response = await handleBlobError(new Error('unauthorized access'), 'blob');
      expect(response.status).toBe(503);

      const body = await response.json();
      expect(body.error).toBe('Storage authentication failed');
    });

    it('サービス利用不可エラーで 503 を返す', async () => {
      const response = await handleBlobError(new Error('service unavailable'), 'blob');
      expect(response.status).toBe(503);

      const body = await response.json();
      expect(body.error).toBe('Storage service temporarily unavailable');
    });

    it.each([
      ['HTTP 503', 503, 'Storage service temporarily unavailable'],
      ['HTTP/1.1 503 Service Unavailable', 503, 'Storage service temporarily unavailable'],
      ['503 Service Unavailable', 503, 'Storage service temporarily unavailable'],
      ['401 Unauthorized', 503, 'Storage authentication failed'],
      ['507 Insufficient Storage', 507, 'Storage quota exceeded'],
      ['status code: 401', 503, 'Storage authentication failed'],
      ['statusCode=503', 503, 'Storage service temporarily unavailable'],
      ['$metadata.httpStatusCode: 507', 507, 'Storage quota exceeded'],
    ])('HTTP status文脈の数値を分類できる: %s', async (errorMessage, expectedStatus, expectedError) => {
      const response = await handleBlobError(new Error(errorMessage), 'blob');
      expect(response.status).toBe(expectedStatus);

      const body = await response.json();
      expect(body.error).toBe(expectedError);
    });

    it.each([
      ['Unauthorized', 503, 'Storage authentication failed'],
      ['Service Unavailable', 503, 'Storage service temporarily unavailable'],
    ])('キーワードの大文字小文字に依存せず分類できる: %s', async (errorMessage, expectedStatus, expectedError) => {
      const response = await handleBlobError(new Error(errorMessage), 'blob');
      expect(response.status).toBe(expectedStatus);

      const body = await response.json();
      expect(body.error).toBe(expectedError);
    });

    it.each([
      '401',
      '503',
      '507',
      'photo-503.png',
      'avatar-401.jpg',
      'asset-507-preview.png',
      'https://example.com/assets/503.png',
    ])('文脈のない数値をHTTP statusとして誤分類しない: %s', async (errorMessage) => {
      const response = await handleBlobError(new Error(errorMessage), 'blob');
      expect(response.status).toBe(500);
    });

    it('Drizzle bind paramsをconsole / DB loggerへ渡す前にmessageから検閲する', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const error = new Error(
        'Failed query: SELECT * FROM cards LIMIT 1\nparams: sensitive-token-value'
      );

      await handleBlobError(error, 'blob context');

      expect(consoleSpy).toHaveBeenCalledWith(
        '[ERROR] blob context: Failed query: SELECT * FROM cards LIMIT 1\nparams: [REDACTED]',
        expect.any(Error)
      );
      expect(logErrorFromLogger).toHaveBeenCalledWith(
        'blob context: Failed query: SELECT * FROM cards LIMIT 1\nparams: [REDACTED]',
        [error]
      );
      consoleSpy.mockRestore();
    });

    it('その他のエラーで 500 を返す', async () => {
      const response = await handleBlobError(new Error('unknown blob error'), 'blob');
      expect(response.status).toBe(500);
    });

    it('非 Error オブジェクトも処理できる', async () => {
      const response = await handleBlobError('string error', 'blob');
      expect(response.status).toBe(500);
    });

    it('additionalInfo が logErrorFromLogger に正しく渡される', async () => {
      const additionalInfo = { userId: '123', action: 'upload' };
      await handleBlobError(new Error('fail'), 'blob context', additionalInfo);

      expect(logErrorFromLogger).toHaveBeenCalledWith(
        'blob context: fail',
        [expect.any(Error), additionalInfo]
      );
    });

    it('additionalInfo が未指定の場合は error のみ渡される', async () => {
      await handleBlobError(new Error('fail'), 'blob context');

      expect(logErrorFromLogger).toHaveBeenCalledWith(
        'blob context: fail',
        [expect.any(Error)]
      );
    });
  });

  describe('非 Error オブジェクトの処理', () => {
    it('string エラーを正しく処理する', async () => {
      const response = await handleApiError('string error', 'test');
      expect(response.status).toBe(500);
      expect(logErrorFromLogger).toHaveBeenCalledWith(
        'test:',
        ['string error']
      );
    });

    it('number エラーを正しく処理する', async () => {
      const response = await handleApiError(123, 'test');
      expect(response.status).toBe(500);
      expect(logErrorFromLogger).toHaveBeenCalled();
    });

    it('null エラーを正しく処理する', async () => {
      const response = await handleApiError(null, 'test');
      expect(response.status).toBe(500);
      expect(logErrorFromLogger).toHaveBeenCalled();
    });

    it('undefined エラーを正しく処理する', async () => {
      const response = await handleApiError(undefined, 'test');
      expect(response.status).toBe(500);
      expect(logErrorFromLogger).toHaveBeenCalled();
    });
  });
});
