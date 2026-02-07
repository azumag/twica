import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  reportError,
  reportApiError,
  reportAuthError,
  reportGachaError,
  reportBattleError,
  reportRealtimeError,
  reportSecurityError,
} from '@/lib/sentry/error-handler';

// Supabase admin のモック
const mockInsert = vi.fn().mockResolvedValue({ error: null });
const mockFrom = vi.fn().mockReturnValue({ insert: mockInsert });

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom }),
}));

describe('sentry/error-handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // console 出力を抑制
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  describe('全 report 関数が Promise を返す', () => {
    it('reportError は Promise を返す', () => {
      const result = reportError(new Error('test'));
      expect(result).toBeInstanceOf(Promise);
    });

    it('reportApiError は Promise を返す', () => {
      const result = reportApiError('/api/test', 'GET', new Error('test'));
      expect(result).toBeInstanceOf(Promise);
    });

    it('reportAuthError は Promise を返す', () => {
      const result = reportAuthError(new Error('test'), { provider: 'twitch' });
      expect(result).toBeInstanceOf(Promise);
    });

    it('reportGachaError は Promise を返す', () => {
      const result = reportGachaError(new Error('test'), { streamerId: '123' });
      expect(result).toBeInstanceOf(Promise);
    });

    it('reportBattleError は Promise を返す', () => {
      const result = reportBattleError(new Error('test'), { battleId: '1' });
      expect(result).toBeInstanceOf(Promise);
    });

    it('reportRealtimeError は Promise を返す', () => {
      const result = reportRealtimeError(new Error('test'), { action: 'subscribe' });
      expect(result).toBeInstanceOf(Promise);
    });

    it('reportSecurityError は Promise を返す', () => {
      const result = reportSecurityError(new Error('test'), { action: 'csrf' });
      expect(result).toBeInstanceOf(Promise);
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

    it('非 Error の場合、String() で変換して記録する', async () => {
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
});
