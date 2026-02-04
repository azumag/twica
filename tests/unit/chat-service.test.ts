import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TwitchChatService } from '@/lib/twitch/chat-service';
import { getTwitchAccessToken, removeScope } from '@/lib/twitch/token-manager';

vi.mock('@/lib/twitch/token-manager');
vi.mock('@/lib/env-validation', () => ({
  getEnvVar: vi.fn().mockReturnValue('test-client-id'),
}));

describe('TwitchChatService', () => {
  let service: TwitchChatService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new TwitchChatService();
  });

  describe('sendChatMessage - self-healing', () => {
    it('401 + スコープ名を含むエラーで removeScope が呼ばれる', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');
      vi.mocked(removeScope).mockResolvedValue(undefined);

      // Twitch APIが401を返すケース（実際に観測されたエラー形式）
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({
          error: 'Unauthorized',
          status: 401,
          message: 'User access token requires the user:write:chat scope.',
        }),
      });

      const result = await service.sendChatMessage('123456789', 'test message');

      expect(result).toBe(false);
      expect(removeScope).toHaveBeenCalledWith('123456789', 'user:write:chat');
    });

    it('401 + "Insufficient authorization" エラーでも removeScope が呼ばれる', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');
      vi.mocked(removeScope).mockResolvedValue(undefined);

      // Twitch APIドキュメントの汎用エラー形式
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({
          error: 'Unauthorized',
          status: 401,
          message: 'Insufficient authorization in token',
        }),
      });

      const result = await service.sendChatMessage('123456789', 'test message');

      expect(result).toBe(false);
      expect(removeScope).toHaveBeenCalledWith('123456789', 'user:write:chat');
    });

    it('401 だがスコープ無関係のエラーでは removeScope が呼ばれない', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');

      // トークン自体が無効なケース（スコープ問題ではない）
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({
          error: 'Unauthorized',
          status: 401,
          message: 'OAuth token is missing',
        }),
      });

      const result = await service.sendChatMessage('123456789', 'test message');

      expect(result).toBe(false);
      expect(removeScope).not.toHaveBeenCalled();
    });

    it('403 エラーでは removeScope が呼ばれない', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: () => Promise.resolve({
          error: 'Forbidden',
          status: 403,
          message: 'User access token requires the user:write:chat scope.',
        }),
      });

      const result = await service.sendChatMessage('123456789', 'test message');

      expect(result).toBe(false);
      expect(removeScope).not.toHaveBeenCalled();
    });

    it('removeScope が失敗しても sendChatMessage は false を返す（例外をスローしない）', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');
      vi.mocked(removeScope).mockRejectedValue(new Error('DB error'));

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({
          error: 'Unauthorized',
          status: 401,
          message: 'User access token requires the user:write:chat scope.',
        }),
      });

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

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [{ message_id: 'msg-123' }] }),
      });

      const result = await service.sendChatMessage('123456789', 'test message');

      expect(result).toBe(true);
      expect(removeScope).not.toHaveBeenCalled();
    });
  });
});
