import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TwitchChatService } from '@/lib/twitch/chat-service';
import { getBotAccountForChat, getTwitchAccessToken, hasScope } from '@/lib/twitch/token-manager';
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
  // リトライの指数バックオフ遅延をテスト時のみ即時解決し、テスト時間を短縮する。
  // describe スコープ内で上書き／復元することで他テストファイルへの副作用を防ぐ。
  // Stub setTimeout to immediate-fire only inside this describe; restored in afterEach
  // so other test files are unaffected.
  const originalSetTimeout = globalThis.setTimeout;

  beforeEach(() => {
    vi.clearAllMocks();
    // 各テストの独立性を保つため fetch mock を初期化
    global.fetch = vi.fn();
    // @ts-expect-error - test-only stub: delay引数を無視してコールバックを即時実行
    globalThis.setTimeout = (cb: () => void) => { cb(); return 0; };
    // デフォルトではスコープあり（個別テストでオーバーライド可能）
    vi.mocked(hasScope).mockResolvedValue(true);
    vi.mocked(getBotAccountForChat).mockResolvedValue(null);
    service = new TwitchChatService();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
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

    it('BOTアカウント設定時はBOTのsender_idとトークンで送信する', async () => {
      vi.mocked(getBotAccountForChat).mockResolvedValue({
        accountId: 'bot-account-id',
        senderId: 'bot-user-id',
        username: 'twica_bot',
        displayName: 'TwiCa Bot',
        accessToken: 'bot-token',
        ownerType: 'streamer',
      });

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [{ message_id: 'msg-123' }] }),
      } as Response);

      const result = await service.sendChatMessage('123456789', 'test message');

      expect(result).toBe(true);
      expect(hasScope).not.toHaveBeenCalled();
      expect(getTwitchAccessToken).not.toHaveBeenCalled();
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.twitch.tv/helix/chat/messages',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer bot-token',
          }),
          body: JSON.stringify({
            broadcaster_id: '123456789',
            sender_id: 'bot-user-id',
            message: 'test message',
          }),
        }),
      );
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

  describe('buildMessage - multi-draw new card placeholders', () => {
    it('N連ガチャ用の {newCards} と {newCardCount} を値に置換する', () => {
      const message = service.buildMessage(
        '{user}: 初出 {newCardCount}種類 {newCards}',
        {
          user: 'viewer',
          card: 'Alpha',
          rarity: 'レア',
          newCards: 'Alpha、Gamma',
          newCardCount: 2,
        },
      );

      expect(message).toBe('viewer: 初出 2種類 Alpha、Gamma');
    });

    it('N連ガチャ用の初出プレースホルダー未指定時は空文字に置換される', () => {
      // newCards / newCardCount どちらも未指定なら空文字置換となり、
      // 「種類」「初出」など接続詞は周辺の連続空白整形で1スペースに丸まる。
      // 「初出」セクション全体を出さないかどうかは呼び出し側の責務（route.ts の
      // shouldAppendDefaultNewCards 判定 / カスタムテンプレート設計）に委ねる。
      // Whether to omit the "初出" section entirely is the caller's responsibility.
      const message = service.buildMessage(
        '{user}: 初出 {newCardCount}種類 {newCards}',
        {
          user: 'viewer',
          card: 'Alpha',
          rarity: 'レア',
        },
      );

      expect(message).toBe('viewer: 初出 種類');
    });

    it('newCardCount=0 を明示的に渡すと "0" として置換される', () => {
      const message = service.buildMessage(
        '{user}: 初出 {newCardCount}種類',
        {
          user: 'viewer',
          card: 'Alpha',
          rarity: 'レア',
          newCardCount: 0,
        },
      );

      expect(message).toBe('viewer: 初出 0種類');
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

  describe('sendChatMessage - 一時的失敗のリトライ (Issue #389)', () => {
    it('500エラーでリトライし、2回目で成功した場合は true を返す', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');

      vi.mocked(global.fetch)
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ error: 'Internal Server Error', message: 'Unknown error' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: [{ message_id: 'msg-123' }] }),
        } as Response);

      const result = await service.sendChatMessage('123456789', 'test message');

      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(2);
      // リトライ成功時は reportApiError は呼ばれない
      expect(reportApiError).not.toHaveBeenCalled();
    });

    it('500エラーが連続で起きた場合は最大3回試行し reportApiError が1度だけ呼ばれる', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');

      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'Internal Server Error', message: 'Unknown error' }),
      } as Response);

      const result = await service.sendChatMessage('123456789', 'test message');

      expect(result).toBe(false);
      expect(global.fetch).toHaveBeenCalledTimes(3);
      // すべて失敗した時のみ1回だけ通報
      expect(reportApiError).toHaveBeenCalledTimes(1);
      expect(reportApiError).toHaveBeenCalledWith(
        '/helix/chat/messages',
        'POST',
        expect.any(Error),
        expect.objectContaining({ broadcasterTwitchUserId: '123456789', status: 500 }),
      );
    });

    it('502/503/504/429 でも同様にリトライ対象', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');

      for (const status of [502, 503, 504, 429]) {
        vi.clearAllMocks();
        vi.mocked(hasScope).mockResolvedValue(true);
        vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');

        vi.mocked(global.fetch)
          .mockResolvedValueOnce({
            ok: false,
            status,
            json: () => Promise.resolve({ error: 'Service Unavailable' }),
          } as Response)
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ data: [{ message_id: 'msg-123' }] }),
          } as Response);

        const result = await service.sendChatMessage('123456789', 'test message');

        expect(result).toBe(true);
        expect(global.fetch).toHaveBeenCalledTimes(2);
      }
    });

    it('401はリトライしない（永続的失敗）', async () => {
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

      const result = await service.sendChatMessage('123456789', 'test message');

      expect(result).toBe(false);
      // 401は1回で終わる（リトライしない）
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(reportApiError).toHaveBeenCalledTimes(1);
    });

    it('404もリトライしない（永続的失敗）', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');

      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: 'Not Found' }),
      } as Response);

      const result = await service.sendChatMessage('123456789', 'test message');

      expect(result).toBe(false);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('ネットワーク例外もリトライ対象、最終的に reportError が1度だけ呼ばれる', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');

      vi.mocked(global.fetch).mockRejectedValue(new Error('ECONNRESET'));

      const result = await service.sendChatMessage('123456789', 'test message');

      expect(result).toBe(false);
      expect(global.fetch).toHaveBeenCalledTimes(3);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportApiError).not.toHaveBeenCalled();
    });

    it('ネットワーク例外→500→200 のように混在しても最終的に成功すれば true', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');

      vi.mocked(global.fetch)
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ error: 'Internal Server Error' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: [{ message_id: 'msg-123' }] }),
        } as Response);

      const result = await service.sendChatMessage('123456789', 'test message');

      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(3);
      expect(reportApiError).not.toHaveBeenCalled();
      expect(reportError).not.toHaveBeenCalled();
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

    it('N連ガチャ用の {cards} と {draws} を値に置換する', () => {
      const message = service.buildMessage(
        '@{user} が{draws}連ガチャで {cards} を獲得！先頭は {card}',
        { ...basePlaceholders, cards: 'Legendary Card、Rare Card、Common Card', draws: 3 }
      );

      expect(message).toBe('@SampleUser が3連ガチャで Legendary Card、Rare Card、Common Card を獲得！先頭は Legendary Card');
    });

    it('N連ガチャ用プレースホルダー未指定時は空文字に置換される', () => {
      const message = service.buildMessage(
        '{user} が {card} を獲得！{draws}{cards}',
        basePlaceholders
      );

      expect(message).toBe('SampleUser が Legendary Card を獲得！');
    });
  });

  // Issue #597: ガチャ報告チャットにカードコレクション(パック)名を出すための {packName}
  describe('buildMessage - パック名プレースホルダー ({packName})', () => {
    const basePlaceholders = {
      user: 'SampleUser',
      card: 'Legendary Card',
      rarity: 'レジェンダリー',
    };

    it('{packName} が値に置換される', () => {
      const message = service.buildMessage(
        '{user}が『{packName}』パックから{card}を獲得！',
        { ...basePlaceholders, packName: 'スターターパック' },
      );

      expect(message).toBe('SampleUserが『スターターパック』パックからLegendary Cardを獲得！');
    });

    it('{packName} 未指定時（パックに絞られていない抽選）は空文字に置換される', () => {
      const message = service.buildMessage(
        '{user}が{card}を獲得！パック: {packName}',
        basePlaceholders,
      );

      expect(message).toBe('SampleUserがLegendary Cardを獲得！パック:');
    });

    it('{packName} が空文字の場合も未指定と同様に空文字へ置換される', () => {
      const message = service.buildMessage(
        '{user}が{card}を獲得！パック: {packName}',
        { ...basePlaceholders, packName: '' },
      );

      expect(message).toBe('SampleUserがLegendary Cardを獲得！パック:');
    });

    it('既存プレースホルダーと併用できる', () => {
      const message = service.buildMessage(
        '@{user} が【{rarity}】{card}（{packName}）を獲得！',
        { ...basePlaceholders, packName: 'レアパック' },
      );

      expect(message).toBe('@SampleUser が【レジェンダリー】Legendary Card（レアパック）を獲得！');
    });
  });
});
