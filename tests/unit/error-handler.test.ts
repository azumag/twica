import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleApiError, handleDatabaseError, handleBlobError } from '@/lib/error-handler';

// sentry/error-handler のモック
vi.mock('@/lib/sentry/error-handler', () => ({
  reportApiError: vi.fn().mockResolvedValue(undefined),
  reportError: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
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

    it('その他のエラーで 500 を返す', async () => {
      const response = await handleBlobError(new Error('unknown blob error'), 'blob');
      expect(response.status).toBe(500);
    });

    it('非 Error オブジェクトも処理できる', async () => {
      const response = await handleBlobError('string error', 'blob');
      expect(response.status).toBe(500);
    });
  });
});
