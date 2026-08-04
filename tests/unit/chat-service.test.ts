import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CHAT_SEND_TERMINAL_CODES, TwitchChatService } from '@/lib/twitch/chat-service';
import {
  getScopeStatus,
  getTwitchAccessToken,
  resolveBotAccountForChat,
  TwitchTokenError,
} from '@/lib/twitch/token-manager';
import { reportApiError, reportError } from '@/lib/sentry/error-handler';

vi.mock('@/lib/twitch/token-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/twitch/token-manager')>();

  return {
    ...actual,
    // 例外クラスまで自動mockするとconstructorがcodeを設定せず、実運用と異なる
    // instanceof/code判定になる。I/O関数だけをmockし、TwitchTokenErrorは実装を維持する。
    getScopeStatus: vi.fn(),
    getTwitchAccessToken: vi.fn(),
    resolveBotAccountForChat: vi.fn(),
  };
});
vi.mock('@/lib/env-validation', () => ({
  getEnvVar: vi.fn().mockReturnValue('test-client-id'),
}));
// 外部エラー永続化はunit testの対象外なのでmockで差し替える
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
    vi.mocked(getScopeStatus).mockResolvedValue('granted');
    vi.mocked(resolveBotAccountForChat).mockResolvedValue({ status: 'not-configured' });
    service = new TwitchChatService();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  });

  describe('sendChatMessage - scope事前チェック', () => {
    it('scope不足の場合、Twitch APIを呼ばずにfalseを返す', async () => {
      vi.mocked(getScopeStatus).mockResolvedValue('missing');

      const result = await service.sendChatMessage('123456789', 'test message');

      expect(result).toBe(false);
      expect(getScopeStatus).toHaveBeenCalledWith('123456789', 'user:write:chat');
      // Twitch APIもトークン取得も呼ばれない
      expect(getTwitchAccessToken).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
      // ユーザーの再認証待ちは既知状態であり、自動Issueを作らない。
      expect(reportError).not.toHaveBeenCalled();
    });

    it('scope付与済みの場合、通常のAPI呼び出しフローに進む', async () => {
      vi.mocked(getScopeStatus).mockResolvedValue('granted');
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [{ message_id: 'msg-123', is_sent: true }] }),
      } as Response);

      const result = await service.sendChatMessage('123456789', 'test message');

      expect(result).toBe(true);
      expect(getScopeStatus).toHaveBeenCalledWith('123456789', 'user:write:chat');
      expect(getTwitchAccessToken).toHaveBeenCalled();
    });

    it('BOTアカウント設定時はBOTのsender_idとトークンで送信する', async () => {
      vi.mocked(resolveBotAccountForChat).mockResolvedValue({
        status: 'available',
        account: {
          accountId: 'bot-account-id',
          senderId: 'bot-user-id',
          username: 'twica_bot',
          displayName: 'TwiCa Bot',
          accessToken: 'bot-token',
          ownerType: 'streamer',
        },
      });

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [{ message_id: 'msg-123', is_sent: true }] }),
      } as Response);

      const result = await service.sendChatMessage('123456789', 'test message');

      expect(result).toBe(true);
      expect(getScopeStatus).not.toHaveBeenCalled();
      expect(getTwitchAccessToken).not.toHaveBeenCalled();
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.twitch.tv/helix/chat/messages',
        expect.objectContaining({
          signal: expect.any(AbortSignal),
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
      vi.mocked(getScopeStatus).mockResolvedValue('granted');
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [{ message_id: 'msg-123', is_sent: true }] }),
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

  describe('sendChatMessageDetailed - outbox再試行分類', () => {
    it('scope未付与とtoken欠落はAPIを呼ばずterminalに分類する', async () => {
      vi.mocked(getScopeStatus).mockResolvedValue('missing');

      await expect(
        service.sendChatMessageDetailed('123456789', 'test message')
      ).resolves.toEqual({
        outcome: 'terminal',
        code: CHAT_SEND_TERMINAL_CODES.MISSING_SCOPE,
        reason: 'user:write:chat scope not granted',
      });
      expect(global.fetch).not.toHaveBeenCalled();

      vi.mocked(getScopeStatus).mockResolvedValue('granted');
      vi.mocked(getTwitchAccessToken).mockResolvedValue(null);
      await expect(
        service.sendChatMessageDetailed('123456789', 'test message')
      ).resolves.toEqual({
        outcome: 'terminal',
        code: CHAT_SEND_TERMINAL_CODES.CREDENTIAL_UNAVAILABLE,
        reason: 'chat sender access token unavailable',
      });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('scope確認不能は恒久的な権限不足へ誤分類せずretryableにする', async () => {
      vi.mocked(getScopeStatus).mockResolvedValue('unavailable');

      await expect(
        service.sendChatMessageDetailed('123456789', 'test message')
      ).resolves.toEqual({
        outcome: 'retryable',
        reason: 'unable to verify user:write:chat scope',
      });
      expect(getTwitchAccessToken).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('BOT一時解決不能かつ本人scope不足はmissing_scopeへ誤分類しない', async () => {
      vi.mocked(resolveBotAccountForChat).mockResolvedValue({
        status: 'retryable-unavailable',
        reason: 'configured BOT credential is temporarily unavailable',
      });
      vi.mocked(getScopeStatus).mockResolvedValue('missing');

      await expect(
        service.sendChatMessageDetailed('123456789', 'test message')
      ).resolves.toEqual({
        outcome: 'retryable',
        reason: 'configured BOT credential is temporarily unavailable',
      });
      expect(getTwitchAccessToken).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('BOT恒久credential欠落かつ本人scope不足はcredential terminalにする', async () => {
      vi.mocked(resolveBotAccountForChat).mockResolvedValue({
        status: 'terminal-unavailable',
        reason: 'configured BOT credential requires reauthorization',
      });
      vi.mocked(getScopeStatus).mockResolvedValue('missing');

      await expect(
        service.sendChatMessageDetailed('123456789', 'test message')
      ).resolves.toEqual({
        outcome: 'terminal',
        code: CHAT_SEND_TERMINAL_CODES.CREDENTIAL_UNAVAILABLE,
        reason: 'configured BOT credential requires reauthorization',
        degradation: {
          code: CHAT_SEND_TERMINAL_CODES.CREDENTIAL_UNAVAILABLE,
          reason: 'configured BOT credential requires reauthorization',
        },
      });
      expect(getTwitchAccessToken).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('BOT解決不能でも本人scope付与済みなら本人credentialへfallbackする', async () => {
      vi.mocked(resolveBotAccountForChat).mockResolvedValue({
        status: 'retryable-unavailable',
        reason: 'configured BOT credential is temporarily unavailable',
      });
      vi.mocked(getScopeStatus).mockResolvedValue('granted');
      vi.mocked(getTwitchAccessToken).mockResolvedValue('streamer-token');
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [{ message_id: 'msg-123', is_sent: true }] }),
      } as Response);

      await expect(
        service.sendChatMessageDetailed('123456789', 'test message')
      ).resolves.toEqual({ outcome: 'sent' });
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.twitch.tv/helix/chat/messages',
        expect.objectContaining({
          body: JSON.stringify({
            broadcaster_id: '123456789',
            sender_id: '123456789',
            message: 'test message',
          }),
        }),
      );
    });

    it('BOT恒久失効でも本人fallback送信を成功させ、typed degradationを上位へ渡す', async () => {
      vi.mocked(resolveBotAccountForChat).mockResolvedValue({
        status: 'terminal-unavailable',
        reason: 'configured BOT credential requires reauthorization',
      });
      vi.mocked(getScopeStatus).mockResolvedValue('granted');
      vi.mocked(getTwitchAccessToken).mockResolvedValue('streamer-token');
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [{ message_id: 'msg-123', is_sent: true }] }),
      } as Response);

      await expect(
        service.sendChatMessageDetailed('123456789', 'test message')
      ).resolves.toEqual({
        outcome: 'sent',
        degradation: {
          code: CHAT_SEND_TERMINAL_CODES.CREDENTIAL_UNAVAILABLE,
          reason: 'configured BOT credential requires reauthorization',
        },
      });
      // 詳細APIはlive/replay境界へ報告責任を渡し、ここでは二重永続化しない。
      expect(reportError).not.toHaveBeenCalled();
    });

    it.each(['DATABASE_ERROR', 'REFRESH_FAILED'] as const)(
      '本人fallbackの%sはcredential terminalへ潰さずretryableにする',
      async (code) => {
        vi.mocked(getScopeStatus).mockResolvedValue('granted');
        vi.mocked(getTwitchAccessToken).mockRejectedValue(
          new TwitchTokenError('temporary credential failure', code),
        );

        await expect(
          service.sendChatMessageDetailed('123456789', 'test message')
        ).resolves.toEqual({
          outcome: 'retryable',
          reason: 'chat sender credential is temporarily unavailable',
        });
        expect(global.fetch).not.toHaveBeenCalled();
      },
    );

    it.each(['NO_TOKEN', 'USER_NOT_FOUND'] as const)(
      '本人fallbackの%sはcredential terminalとして報告対象を維持する',
      async (code) => {
        vi.mocked(getScopeStatus).mockResolvedValue('granted');
        vi.mocked(getTwitchAccessToken).mockRejectedValue(
          new TwitchTokenError('permanent credential failure', code),
        );

        await expect(
          service.sendChatMessageDetailed('123456789', 'test message')
        ).resolves.toEqual({
          outcome: 'terminal',
          code: CHAT_SEND_TERMINAL_CODES.CREDENTIAL_UNAVAILABLE,
          reason: 'chat sender access token unavailable',
        });
        expect(global.fetch).not.toHaveBeenCalled();
      },
    );

    it('本人fallbackの未知例外は上位retry/report境界へ伝播する', async () => {
      vi.mocked(getScopeStatus).mockResolvedValue('granted');
      vi.mocked(getTwitchAccessToken).mockRejectedValue(new Error('unexpected token failure'));

      await expect(
        service.sendChatMessageDetailed('123456789', 'test message')
      ).rejects.toThrow('unexpected token failure');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('401はterminal、503は最大試行後retryableに分類する', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');
      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({
          error: 'Unauthorized',
          message: 'Insufficient authorization in token',
        }),
      } as Response);

      await expect(
        service.sendChatMessageDetailed('123456789', 'test message')
      ).resolves.toEqual({
        outcome: 'terminal',
        code: CHAT_SEND_TERMINAL_CODES.TWITCH_REJECTED,
        reason: 'Twitch API 401: Insufficient authorization in token',
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);

      vi.mocked(global.fetch).mockClear();
      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 503,
        json: () => Promise.resolve({
          error: 'Service Unavailable',
          message: 'temporary outage',
        }),
      } as Response);
      await expect(
        service.sendChatMessageDetailed('123456789', 'test message')
      ).resolves.toEqual({
        outcome: 'retryable',
        reason: 'Twitch API 503: temporary outage',
      });
      expect(global.fetch).toHaveBeenCalledTimes(3);
      // outbox詳細APIはterminal/retryableを分類するだけで、下位永続化を行わない。
      expect(reportApiError).not.toHaveBeenCalled();
      expect(reportError).not.toHaveBeenCalled();
    });

    it('network例外はfence有無に関係なく下位報告せずretryableに分類する', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');
      vi.mocked(global.fetch).mockRejectedValue(new Error('ECONNRESET'));
      const beforeExternalSend = vi.fn().mockResolvedValue(true);

      await expect(
        service.sendChatMessageDetailed('123456789', 'test message', { beforeExternalSend })
      ).resolves.toEqual({
        outcome: 'retryable',
        reason: 'ECONNRESET',
      });
      expect(global.fetch).toHaveBeenCalledTimes(3);
      expect(beforeExternalSend).toHaveBeenCalledTimes(3);
      expect(reportApiError).not.toHaveBeenCalled();
      expect(reportError).not.toHaveBeenCalled();
    });

    it('外部送信直前fenceがfalseまたはthrowならfetchせずabortedに分類する', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');

      await expect(service.sendChatMessageDetailed('123456789', 'test message', {
        beforeExternalSend: vi.fn().mockResolvedValue(false),
      })).resolves.toEqual({ outcome: 'aborted', reason: 'chat delivery ownership lost before send' });
      expect(global.fetch).not.toHaveBeenCalled();

      await expect(service.sendChatMessageDetailed('123456789', 'test message', {
        beforeExternalSend: vi.fn().mockRejectedValue(new Error('lease lost')),
      })).resolves.toEqual({ outcome: 'aborted', reason: 'chat delivery fence failed: lease lost' });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it.each([408, 429, 500, 522, 523, 524])('HTTP %iは最大3回後retryableに分類する', async (status) => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');
      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status,
        json: () => Promise.resolve({ message: 'temporary outage' }),
      } as Response);

      await expect(service.sendChatMessageDetailed('123456789', 'test message')).resolves.toEqual({
        outcome: 'retryable',
        reason: `Twitch API ${status}: temporary outage`,
      });
      expect(global.fetch).toHaveBeenCalledTimes(3);
      expect(reportApiError).not.toHaveBeenCalled();
      expect(reportError).not.toHaveBeenCalled();
    });

    it('HTTP 200でもis_sent=falseならdrop_reason付きterminalに分類する', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          data: [{
            message_id: '',
            is_sent: false,
            drop_reason: {
              code: 'automod_held',
              message: 'The message was held by AutoMod.',
            },
          }],
        }),
      } as Response);

      await expect(
        service.sendChatMessageDetailed('123456789', 'test message')
      ).resolves.toEqual({
        outcome: 'terminal',
        code: CHAT_SEND_TERMINAL_CODES.TWITCH_REJECTED,
        reason: 'Twitch API 200: The message was held by AutoMod.',
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(reportApiError).not.toHaveBeenCalled();
      expect(reportError).not.toHaveBeenCalled();
    });

    // issue #842/#843: 同じ視聴者が同じカードを30秒以内に引くとテンプレート展開後の
    // 本文が完全一致し、Twitchが msg_duplicate で抑止する。障害ではないため
    // terminal（DLQ + エラー報告）と分けて分類する。
    it('drop_reasonがmsg_duplicateならterminalではなくduplicateに分類する', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          data: [{
            message_id: '',
            is_sent: false,
            drop_reason: {
              code: 'msg_duplicate',
              message: 'Your message was not sent because it is identical to the previous one you sent, less than 30 seconds ago.',
            },
          }],
        }),
      } as Response);

      await expect(
        service.sendChatMessageDetailed('123456789', 'test message')
      ).resolves.toEqual({
        outcome: 'duplicate',
        reason: 'Your message was not sent because it is identical to the previous one you sent, less than 30 seconds ago.',
      });
      // 同一本文の再送はTwitchが再び抑止するため、無駄な再試行をしない
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('msg_duplicateはboolean契約のsendChatMessageでも失敗扱いにしない', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          data: [{
            message_id: '',
            is_sent: false,
            drop_reason: { code: 'msg_duplicate', message: 'duplicate' },
          }],
        }),
      } as Response);

      await expect(service.sendChatMessage('123456789', 'test message')).resolves.toBe(true);
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

    it('{newCardsOrNone} に初入手カード名一覧を渡すと置換する', () => {
      const message = service.buildMessage(
        '{user}: 初入手 {newCardsOrNone}',
        {
          user: 'viewer',
          card: 'Alpha',
          rarity: 'レア',
          newCardsOrNone: 'Alpha、Gamma',
        },
      );

      expect(message).toBe('viewer: 初入手 Alpha、Gamma');
    });

    it('{newCardsOrNone} に正常0件用の「なし」を渡すと置換する', () => {
      const message = service.buildMessage(
        '{user}: 初入手 {newCardsOrNone}',
        {
          user: 'viewer',
          card: 'Alpha',
          rarity: 'レア',
          newCardsOrNone: 'なし',
        },
      );

      expect(message).toBe('viewer: 初入手 なし');
    });

    it('{newCardsOrNone} 未指定時は既存の任意placeholderと同様に空文字へ置換する', () => {
      const message = service.buildMessage(
        '{user}: 初入手 {newCardsOrNone}',
        {
          user: 'viewer',
          card: 'Alpha',
          rarity: 'レア',
        },
      );

      expect(message).toBe('viewer: 初入手');
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
        json: () => Promise.resolve({ data: [{ message_id: 'msg-123', is_sent: true }] }),
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

    it('scope確認不能のpreflight失敗はlegacy経路でもreportErrorを1回残す', async () => {
      vi.mocked(getScopeStatus).mockResolvedValue('unavailable');

      await expect(service.sendChatMessage('123456789', 'test message')).resolves.toBe(false);

      expect(global.fetch).not.toHaveBeenCalled();
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Chat delivery preflight failed: unable to verify user:write:chat scope',
        }),
        expect.objectContaining({
          context: 'chat-service:sendChatMessage:preflight',
          broadcasterTwitchUserId: '123456789',
          outcome: 'retryable',
        }),
      );
    });

    it('credential欠落のpreflight失敗はlegacy経路でもreportErrorを1回残す', async () => {
      vi.mocked(getTwitchAccessToken).mockRejectedValue(
        new TwitchTokenError('missing credential', 'NO_TOKEN'),
      );

      await expect(service.sendChatMessage('123456789', 'test message')).resolves.toBe(false);

      expect(global.fetch).not.toHaveBeenCalled();
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Chat delivery preflight failed: chat sender access token unavailable',
        }),
        expect.objectContaining({
          context: 'chat-service:sendChatMessage:preflight',
          broadcasterTwitchUserId: '123456789',
          outcome: 'terminal',
          code: CHAT_SEND_TERMINAL_CODES.CREDENTIAL_UNAVAILABLE,
        }),
      );
    });

    it('legacy経路はBOT恒久失効からのfallback送信成功をtrueのまま1回reportする', async () => {
      vi.mocked(resolveBotAccountForChat).mockResolvedValue({
        status: 'terminal-unavailable',
        reason: 'configured BOT credential requires reauthorization',
      });
      vi.mocked(getTwitchAccessToken).mockResolvedValue('streamer-token');
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [{ message_id: 'msg-123', is_sent: true }] }),
      } as Response);

      await expect(service.sendChatMessage('123456789', 'test message')).resolves.toBe(true);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('configured BOT credential requires reauthorization'),
        }),
        expect.objectContaining({
          context: 'chat-service:sendChatMessage:degraded-success',
          outcome: 'sent',
          degradation: {
            code: CHAT_SEND_TERMINAL_CODES.CREDENTIAL_UNAVAILABLE,
            reason: 'configured BOT credential requires reauthorization',
          },
        }),
      );
    });

    // BOT恒久失効(degradation)は本人credentialへのfallback後もAPI失敗し得る。
    // legacy boolean経路は下位報告が唯一の永続化点のため、preflight報告と同様に
    // degradationを載せないと「設定BOTが要再認証」のシグナルが失われる。
    it('fallback送信のAPI失敗でもreportApiErrorへdegradationを載せる', async () => {
      vi.mocked(resolveBotAccountForChat).mockResolvedValue({
        status: 'terminal-unavailable',
        reason: 'configured BOT credential requires reauthorization',
      });
      vi.mocked(getTwitchAccessToken).mockResolvedValue('streamer-token');
      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: 'Unauthorized', status: 401, message: 'invalid token' }),
      } as Response);

      await expect(service.sendChatMessage('123456789', 'test message')).resolves.toBe(false);
      expect(reportApiError).toHaveBeenCalledWith(
        '/helix/chat/messages',
        'POST',
        expect.any(Error),
        expect.objectContaining({
          broadcasterTwitchUserId: '123456789',
          status: 401,
          degradation: {
            code: CHAT_SEND_TERMINAL_CODES.CREDENTIAL_UNAVAILABLE,
            reason: 'configured BOT credential requires reauthorization',
          },
        }),
      );
    });

    it('fallback送信のネットワーク例外でもreportErrorへdegradationを載せる', async () => {
      vi.mocked(resolveBotAccountForChat).mockResolvedValue({
        status: 'terminal-unavailable',
        reason: 'configured BOT credential requires reauthorization',
      });
      vi.mocked(getTwitchAccessToken).mockResolvedValue('streamer-token');
      vi.mocked(global.fetch).mockRejectedValue(new Error('ECONNRESET'));

      await expect(service.sendChatMessage('123456789', 'test message')).resolves.toBe(false);
      expect(reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          context: 'chat-service:sendChatMessage',
          broadcasterTwitchUserId: '123456789',
          degradation: {
            code: CHAT_SEND_TERMINAL_CODES.CREDENTIAL_UNAVAILABLE,
            reason: 'configured BOT credential requires reauthorization',
          },
        }),
      );
    });

    it('送信成功時は reportApiError/reportError が呼ばれない', async () => {
      vi.mocked(getTwitchAccessToken).mockResolvedValue('test-token');

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [{ message_id: 'msg-123', is_sent: true }] }),
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
          json: () => Promise.resolve({ data: [{ message_id: 'msg-123', is_sent: true }] }),
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
        vi.mocked(getScopeStatus).mockResolvedValue('granted');
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
            json: () => Promise.resolve({ data: [{ message_id: 'msg-123', is_sent: true }] }),
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
          json: () => Promise.resolve({ data: [{ message_id: 'msg-123', is_sent: true }] }),
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
