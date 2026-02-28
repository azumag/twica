import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TwitchChatService } from '@/lib/twitch/chat-service';
import { getTwitchAccessToken, hasScope } from '@/lib/twitch/token-manager';
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
    // デフォルトではスコープあり（個別テストでオーバーライド可能）
    vi.mocked(hasScope).mockResolvedValue(true);
    service = new TwitchChatService();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('sendChatMessage - hasScope事前チェック', () => {
    it('hasScope=falseの場合、Twitch APIを呼ばずにfalseを返す', async () => {
      vi.mocked(hasScope).mockResolvedValue(false);

      const result = await service.sendChatMessage('123456789', 'test message');

      expect(result).toBe(false);
      expect(hasScope).toHaveBeenCalledWith('123456789', 'user:write:chat');
      // Twitch APIもトークン取得も呼ばれない
      expect(getTwitchAccessToken).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('hasScope=trueの場合、通常のAPI呼び出しフローに進む', async () => {
      vi.mocked(hasScope).mockResolvedValue(true);
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [{ message_id: 'msg-123' }] }),
      } as Response);

      const result = await service.sendChatMessage('123456789', 'test message');

      expect(result).toBe(true);
      expect(hasScope).toHaveBeenCalledWith('123456789', 'user:write:chat');
      expect(getTwitchAccessToken).toHaveBeenCalled();
    });
  });

  describe('sendChatMessage - 401エラー時のDB保護', () => {
    it('401 + スコープエラーでもDBのスコープは削除されない（DB保護）', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');

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
      // removeScope は呼ばれない（インポートされていないことで保証）
    });

    it('401 + "Insufficient authorization" エラーでもDBのスコープは削除されない', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');

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
    });

    it('アクセストークンがない場合は API を呼ばず false を返す', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue(null);

      const result = await service.sendChatMessage('123456789', 'test message');

      expect(result).toBe(false);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('送信成功時は true を返す', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [{ message_id: 'msg-123' }] }),
      } as Response);

      const result = await service.sendChatMessage('123456789', 'test message');

      expect(result).toBe(true);
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

    it('401スコープエラー時にもreportApiErrorが呼ばれる（DB変更なし）', async () => {
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

      // reportApiError (API失敗) は呼ばれる
      expect(reportApiError).toHaveBeenCalledWith(
        '/helix/chat/messages',
        'POST',
        expect.any(Error),
        expect.objectContaining({ broadcasterTwitchUserId: '123456789', status: 401 }),
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

      // reportApiError が失敗しても try-catch で捕捉され false を返す
      expect(result).toBe(false);
    });

    it('ネットワークエラー時に reportError が reject しても sendChatMessage は false を返す', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');
      vi.mocked(global.fetch).mockRejectedValue(new Error('Network error'));
      // reportError 自体も失敗するケース
      vi.mocked(reportError).mockRejectedValue(new Error('Supabase down'));

      const result = await service.sendChatMessage('123456789', 'test message');

      // 外側 catch 内の reportError が失敗しても例外が漏れず false を返す
      expect(result).toBe(false);
    });
  });
});
