import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TwitchChatService } from '@/lib/twitch/chat-service';
import { getTwitchAccessToken, removeScope } from '@/lib/twitch/token-manager';
import { reportApiError, reportError } from '@/lib/sentry/error-handler';

vi.mock('@/lib/twitch/token-manager');
vi.mock('@/lib/env-validation', () => ({
  getEnvVar: vi.fn().mockReturnValue('test-client-id'),
}));
// reportApiError/reportError は Supabase を使うため mock で差し替え
vi.mock('@/lib/sentry/error-handler', () => ({
  reportApiError: vi.fn().mockResolvedValue(undefined),
  reportError: vi.fn().mockResolvedValue(undefined),
}));

describe('TwitchChatService', () => {
  let service: TwitchChatService;
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    // 各テストの独立性を保つため fetch mock を初期化
    global.fetch = vi.fn();
    service = new TwitchChatService();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('sendChatMessage - self-healing', () => {
    it('401 + スコープ名を含むエラーで removeScope が呼ばれる', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');
      vi.mocked(removeScope).mockResolvedValue(undefined);

      // Twitch APIが401を返すケース（実際に観測されたエラー形式）
      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({
          error: 'Unauthorized',
          status: 401,
          message: 'User access token requires the user:write:chat scope.',
        }),
      } as Response);

      const result = await service.sendChatMessage('123456789', 'test message');

      expect(result).toBe(false);
      expect(removeScope).toHaveBeenCalledWith('123456789', 'user:write:chat');
    });

    it('401 + "Insufficient authorization" エラーでも removeScope が呼ばれる', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');
      vi.mocked(removeScope).mockResolvedValue(undefined);

      // Twitch APIドキュメントの汎用エラー形式
      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({
          error: 'Unauthorized',
          status: 401,
          message: 'Insufficient authorization in token',
        }),
      } as Response);

      const result = await service.sendChatMessage('123456789', 'test message');

      expect(result).toBe(false);
      expect(removeScope).toHaveBeenCalledWith('123456789', 'user:write:chat');
    });

    it('401 だがスコープ無関係のエラーでは removeScope が呼ばれない', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');

      // トークン自体が無効なケース（スコープ問題ではない）
      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({
          error: 'Unauthorized',
          status: 401,
          message: 'OAuth token is missing',
        }),
      } as Response);

      const result = await service.sendChatMessage('123456789', 'test message');

      expect(result).toBe(false);
      expect(removeScope).not.toHaveBeenCalled();
    });

    it('403 エラーでは removeScope が呼ばれない', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');

      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 403,
        json: () => Promise.resolve({
          error: 'Forbidden',
          status: 403,
          message: 'User access token requires the user:write:chat scope.',
        }),
      } as Response);

      const result = await service.sendChatMessage('123456789', 'test message');

      expect(result).toBe(false);
      expect(removeScope).not.toHaveBeenCalled();
    });

    it('removeScope が失敗しても sendChatMessage は false を返す（例外をスローしない）', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');
      vi.mocked(removeScope).mockRejectedValue(new Error('DB error'));

      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({
          error: 'Unauthorized',
          status: 401,
          message: 'User access token requires the user:write:chat scope.',
        }),
      } as Response);

      const result = await service.sendChatMessage('123456789', 'test message');

      expect(result).toBe(false);
      expect(removeScope).toHaveBeenCalled();
    });

    it('アクセストークンがない場合は API を呼ばず false を返す', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue(null);

      const result = await service.sendChatMessage('123456789', 'test message');

      expect(result).toBe(false);
      expect(global.fetch).not.toHaveBeenCalled();
      expect(removeScope).not.toHaveBeenCalled();
    });

    it('送信成功時は true を返し removeScope は呼ばれない', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [{ message_id: 'msg-123' }] }),
      } as Response);

      const result = await service.sendChatMessage('123456789', 'test message');

      expect(result).toBe(true);
      expect(removeScope).not.toHaveBeenCalled();
    });
  });

  describe('sendChatMessage - error reporting', () => {
    it('API エラー時に reportApiError が正しい引数で呼ばれる', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');

      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({
          error: 'Unauthorized',
          status: 401,
          message: 'User access token requires the user:write:chat scope.',
        }),
      } as Response);

      await service.sendChatMessage('123456789', 'test message');

      expect(reportApiError).toHaveBeenCalledWith(
        '/helix/chat/messages',
        'POST',
        expect.any(Error),
        expect.objectContaining({
          broadcasterTwitchUserId: '123456789',
          status: 401,
          twitchError: 'Unauthorized',
        }),
      );
    });

    it('ネットワークエラー時に reportError が呼ばれる', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');

      vi.mocked(global.fetch).mockRejectedValue(new Error('Network error'));

      const result = await service.sendChatMessage('123456789', 'test message');

      expect(result).toBe(false);
      expect(reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          context: 'chat-service:sendChatMessage',
          broadcasterTwitchUserId: '123456789',
        }),
      );
    });

    it('送信成功時は reportApiError/reportError が呼ばれない', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [{ message_id: 'msg-123' }] }),
      } as Response);

      await service.sendChatMessage('123456789', 'test message');

      expect(reportApiError).not.toHaveBeenCalled();
      expect(reportError).not.toHaveBeenCalled();
    });

    it('self-healing 失敗時に reportApiError と reportError の両方が呼ばれる', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');
      const dbError = new Error('DB error');
      vi.mocked(removeScope).mockRejectedValue(dbError);

      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({
          error: 'Unauthorized',
          status: 401,
          message: 'User access token requires the user:write:chat scope.',
        }),
      } as Response);

      await service.sendChatMessage('123456789', 'test message');

      // reportApiError (API失敗) の引数も検証
      expect(reportApiError).toHaveBeenCalledWith(
        '/helix/chat/messages',
        'POST',
        expect.any(Error),
        expect.objectContaining({ broadcasterTwitchUserId: '123456789', status: 401 }),
      );
      // reportError (self-healing失敗) の引数も検証
      expect(reportError).toHaveBeenCalledWith(
        dbError,
        expect.objectContaining({
          context: 'chat-service:removeScope:self-healing',
          broadcasterTwitchUserId: '123456789',
        }),
      );
    });

    it('reportApiError が reject しても sendChatMessage は false を返す', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');
      vi.mocked(reportApiError).mockRejectedValue(new Error('Supabase down'));

      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'Internal Server Error' }),
      } as Response);

      const result = await service.sendChatMessage('123456789', 'test message');

      // reportApiError が失敗しても、外側の catch で捕捉されて false を返す
      expect(result).toBe(false);
    });
  });
});
