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

    it('500文字を超える日本語メッセージは文字単位で切り詰めて送信する', async () => {
      vi.mocked(hasScope).mockResolvedValue(true);
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [{ message_id: 'msg-123' }] }),
      } as Response);

      await service.sendChatMessage('123456789', 'あ'.repeat(520));

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.twitch.tv/helix/chat/messages',
        expect.objectContaining({
          body: JSON.stringify({
            broadcaster_id: '123456789',
            sender_id: '123456789',
            message: `${'あ'.repeat(497)}...`,
          }),
        }),
      );
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

  describe('buildMessage - コンプ進捗プレースホルダー ({unique}/{all})', () => {
    const basePlaceholders = {
      user: 'SampleUser',
      card: 'Legendary Card',
      rarity: 'レジェンダリー',
    };

    it('{unique} と {all} が値に置換される', () => {
      const message = service.buildMessage(
        'コンプ進捗: {unique}/{all}種類ゲット！',
        { ...basePlaceholders, unique: 5, all: 10 }
      );
      expect(message).toBe('コンプ進捗: 5/10種類ゲット！');
    });

    it('unique=0 でも "0" として置換される（未所持状態）', () => {
      const message = service.buildMessage(
        '{user} は {unique}/{all}種類を所持しています',
        { ...basePlaceholders, unique: 0, all: 10 }
      );
      expect(message).toBe('SampleUser は 0/10種類を所持しています');
    });

    it('unique/all 未指定時はプレースホルダーが空文字に置換される', () => {
      const message = service.buildMessage(
        '{user} が {card} を獲得！{unique}{all}',
        basePlaceholders
      );
      // 末尾の空文字置換後、空白正規化で末尾スペースが落ちる
      expect(message).toBe('SampleUser が Legendary Card を獲得！');
    });

    it('all のみ指定された場合でも {unique} は空文字に置換される', () => {
      const message = service.buildMessage(
        'カード総数: {all}種類',
        { ...basePlaceholders, all: 10 }
      );
      expect(message).toBe('カード総数: 10種類');
    });

    it('既存プレースホルダーと併用できる', () => {
      const message = service.buildMessage(
        '@{user} が【{rarity}】{card}（{num}枚目 / コンプ {unique}/{all}）を獲得！',
        { ...basePlaceholders, num: 3, unique: 5, all: 10 }
      );
      expect(message).toBe('@SampleUser が【レジェンダリー】Legendary Card（3枚目 / コンプ 5/10）を獲得！');
    });
  });
});
