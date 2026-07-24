import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getTwitchAccessToken, saveTwitchTokens, deleteTwitchTokens, removeScope, saveTwitchScopes, hasScope, validateTokenScopes } from '@/lib/twitch/token-manager';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { refreshTwitchToken } from '@/lib/twitch/auth';

vi.mock('@/lib/supabase/admin');
vi.mock('@/lib/twitch/auth');

type MockSupabaseAdmin = {
  from: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  maybeSingle?: ReturnType<typeof vi.fn>;
  single?: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
};

describe('Twitch Token Manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getTwitchAccessToken', () => {
    it('有効なトークンを返す', async () => {
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            twitch_access_token: 'valid-token',
            twitch_refresh_token: 'refresh-token',
            twitch_token_expires_at: new Date(Date.now() + 3600000).toISOString(),
          },
          error: null,
        }),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };

      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never);

      const token = await getTwitchAccessToken('123456789');
      expect(token).toBe('valid-token');
    });

    it('トークンが存在しない場合は null を返す', async () => {
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: null,
          error: null,
        }),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };

      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never);

      const token = await getTwitchAccessToken('123456789');
      expect(token).toBeNull();
    });

    // maybeSingle()ではユーザーが見つからない場合、error=nullかつdata=nullが返る
    it('ユーザーが見つからない場合は null を返す', async () => {
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: null,
          error: null,
        }),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };

      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never);

      const token = await getTwitchAccessToken('123456789');
      expect(token).toBeNull();
    });

    it('データベースエラーは例外をスローする', async () => {
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: null,
          error: { code: 'PGRST000', message: 'Database connection failed' },
        }),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };

      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never);

      await expect(getTwitchAccessToken('123456789')).rejects.toThrow('Failed to fetch user tokens from database');
    });

    it('一時的な502の後にトークン取得をリトライする', async () => {
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn()
          .mockResolvedValueOnce({
            status: 502,
            error: { code: '502', message: 'error code: 502' },
          })
          .mockResolvedValueOnce({
            data: {
              twitch_access_token: 'valid-token-after-retry',
              twitch_refresh_token: 'refresh-token',
              twitch_token_expires_at: new Date(Date.now() + 3600000).toISOString(),
            },
            error: null,
          }),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };

      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never);

      const token = await getTwitchAccessToken('123456789');
      expect(token).toBe('valid-token-after-retry');
      expect(mockSupabaseAdmin.maybeSingle).toHaveBeenCalledTimes(2);
    });

    it('期限切れのトークンを更新する', async () => {
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn()
          .mockResolvedValueOnce({
            data: {
              twitch_access_token: 'expired-token',
              twitch_refresh_token: 'refresh-token',
              twitch_token_expires_at: new Date(Date.now() - 3600000).toISOString(),
            },
            error: null,
          })
          .mockResolvedValueOnce({ data: { twitch_access_token: 'new-token' }, error: null }),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };

      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never);
      vi.mocked(refreshTwitchToken).mockResolvedValue({
        access_token: 'new-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
        token_type: 'bearer',
        scope: ['user:read:email'],
      });

      const token = await getTwitchAccessToken('123456789');
      expect(token).toBe('new-token');
      expect(refreshTwitchToken).toHaveBeenCalledWith('refresh-token');
    });

    it('refresh失敗後も次の呼び出しが再試行できる', async () => {
      const expired = {
        twitch_access_token: 'expired-token',
        twitch_refresh_token: 'refresh-token',
        twitch_token_expires_at: new Date(Date.now() - 3600000).toISOString(),
      };
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn()
          .mockResolvedValueOnce({ data: expired, error: null })
          .mockResolvedValueOnce({ data: expired, error: null })
          .mockResolvedValueOnce({ data: { twitch_access_token: 'recovered-token' }, error: null }),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };
      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never);
      vi.mocked(refreshTwitchToken)
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValueOnce({
          access_token: 'recovered-token',
          refresh_token: 'recovered-refresh',
          expires_in: 3600,
          token_type: 'bearer',
          scope: [],
        });

      await expect(getTwitchAccessToken('flight-cleanup-user')).rejects.toMatchObject({
        code: 'REFRESH_FAILED',
      });
      await expect(getTwitchAccessToken('flight-cleanup-user')).resolves.toBe('recovered-token');
      expect(refreshTwitchToken).toHaveBeenCalledTimes(2);
    });

    it('異なるユーザーのrefreshは互いに待たず独立して実行する', async () => {
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn()
          .mockResolvedValueOnce({ data: {
            twitch_access_token: 'expired-a',
            twitch_refresh_token: 'refresh-a',
            twitch_token_expires_at: new Date(0).toISOString(),
          }, error: null })
          .mockResolvedValueOnce({ data: {
            twitch_access_token: 'expired-b',
            twitch_refresh_token: 'refresh-b',
            twitch_token_expires_at: new Date(0).toISOString(),
          }, error: null })
          .mockResolvedValueOnce({ data: { twitch_access_token: 'token-a' }, error: null })
          .mockResolvedValueOnce({ data: { twitch_access_token: 'token-b' }, error: null }),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };
      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never);
      const resolvers = new Map<string, (tokens: {
        access_token: string; refresh_token: string; expires_in: number; token_type: string; scope: string[];
      }) => void>();
      vi.mocked(refreshTwitchToken).mockImplementation(refreshToken => new Promise(resolve => {
        resolvers.set(refreshToken, resolve);
      }));

      const first = getTwitchAccessToken('user-a');
      const second = getTwitchAccessToken('user-b');
      await vi.waitFor(() => expect(refreshTwitchToken).toHaveBeenCalledTimes(2));
      resolvers.get('refresh-a')?.({ access_token: 'token-a', refresh_token: 'next-a', expires_in: 3600, token_type: 'bearer', scope: [] });
      resolvers.get('refresh-b')?.({ access_token: 'token-b', refresh_token: 'next-b', expires_in: 3600, token_type: 'bearer', scope: [] });

      await expect(Promise.all([first, second])).resolves.toEqual(['token-a', 'token-b']);
      expect(refreshTwitchToken).toHaveBeenCalledTimes(2);
    });
  });

  describe('saveTwitchTokens', () => {
    it('トークンを保存する', async () => {
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: null, error: null }),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };

      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never);

      await saveTwitchTokens('123456789', {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
        token_type: 'bearer',
        scope: ['user:read:email'],
      });

      expect(mockSupabaseAdmin.from).toHaveBeenCalledWith('users');
      expect(mockSupabaseAdmin.update).toHaveBeenCalledWith(
        expect.objectContaining({
          twitch_access_token: 'access-token',
          twitch_refresh_token: 'refresh-token',
        })
      );
    });
  });

  describe('deleteTwitchTokens', () => {
    it('トークンを削除する', async () => {
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: null, error: null }),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };

      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never);

      await deleteTwitchTokens('123456789');

      expect(mockSupabaseAdmin.from).toHaveBeenCalledWith('users');
      expect(mockSupabaseAdmin.update).toHaveBeenCalledWith(
        expect.objectContaining({
          twitch_access_token: null,
          twitch_refresh_token: null,
          twitch_token_expires_at: null,
        })
      );
    });
  });

  describe('removeScope', () => {
    it('指定スコープをtwitch_scopesから削除する', async () => {
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            twitch_scopes: ['user:read:email', 'channel:read:redemptions', 'user:write:chat'],
          },
          error: null,
        }),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };

      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never);

      await removeScope('123456789', 'user:write:chat');

      expect(mockSupabaseAdmin.update).toHaveBeenCalledWith({
        twitch_scopes: ['user:read:email', 'channel:read:redemptions'],
      });
    });

    it('スコープが存在しない場合はDB更新しない', async () => {
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            twitch_scopes: ['user:read:email', 'channel:read:redemptions'],
          },
          error: null,
        }),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };

      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never);

      await removeScope('123456789', 'user:write:chat');

      // update は select/eq チェーンの一部として呼ばれないことを確認
      // from は select チェーンで1回呼ばれるが、update チェーンでは呼ばれない
      expect(mockSupabaseAdmin.update).not.toHaveBeenCalled();
    });

    it('twitch_scopesがnullの場合はDB更新しない', async () => {
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: { twitch_scopes: null },
          error: null,
        }),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };

      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never);

      await removeScope('123456789', 'user:write:chat');

      expect(mockSupabaseAdmin.update).not.toHaveBeenCalled();
    });

    it('DBフェッチエラー時は例外をスローせず静かに返す', async () => {
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: null,
          error: { code: 'PGRST000', message: 'Connection failed' },
        }),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };

      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never);

      // 例外がスローされないことを確認
      await expect(removeScope('123456789', 'user:write:chat')).resolves.toBeUndefined();
    });
  });

  describe('saveTwitchScopes', () => {
    it('スコープをDBに保存する', async () => {
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };

      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never);

      const scopes = ['user:read:email', 'channel:read:redemptions', 'user:write:chat'];
      await saveTwitchScopes('123456789', scopes);

      expect(mockSupabaseAdmin.from).toHaveBeenCalledWith('users');
      expect(mockSupabaseAdmin.update).toHaveBeenCalledWith({
        twitch_scopes: scopes,
      });
    });

    it('PGRST204エラー時は例外をスローせず返す', async () => {
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({
          error: { code: 'PGRST204', message: 'Column not found' },
        }),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };

      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never);

      await expect(saveTwitchScopes('123456789', ['user:read:email'])).resolves.toBeUndefined();
    });

    it('その他のDBエラー時は例外をスローする', async () => {
      const dbError = { code: 'PGRST000', message: 'Connection failed' };
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({
          error: dbError,
        }),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };

      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never);

      await expect(saveTwitchScopes('123456789', ['user:read:email'])).rejects.toEqual(dbError);
    });
  });

  describe('hasScope', () => {
    it('ユーザーがスコープを持っている場合はtrueを返す', async () => {
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            twitch_scopes: ['user:read:email', 'user:write:chat'],
          },
          error: null,
        }),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };

      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never);

      const result = await hasScope('123456789', 'user:write:chat');
      expect(result).toBe(true);
    });

    it('scope確認のDB読み取りがCloudflare 500から復旧した場合はリトライしてtrueを返す', async () => {
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn()
          .mockResolvedValueOnce({
            status: 500,
            error: {
              message: '<html><head><title>500 Internal Server Error</title></head><body>cloudflare</body></html>',
            },
          })
          .mockResolvedValueOnce({
            status: 200,
            data: {
              twitch_scopes: ['user:read:email', 'user:write:chat'],
            },
            error: null,
          }),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };

      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never);

      const result = await hasScope('123456789', 'user:write:chat');
      expect(result).toBe(true);
      expect(mockSupabaseAdmin.maybeSingle).toHaveBeenCalledTimes(2);
    });

    it('ユーザーがスコープを持っていない場合はfalseを返す', async () => {
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            twitch_scopes: ['user:read:email'],
          },
          error: null,
        }),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };

      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never);

      const result = await hasScope('123456789', 'user:write:chat');
      expect(result).toBe(false);
    });

    it('twitch_scopesがnullの場合はfalseを返す', async () => {
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: { twitch_scopes: null },
          error: null,
        }),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };

      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never);

      const result = await hasScope('123456789', 'user:write:chat');
      expect(result).toBe(false);
    });

    it('ユーザーが存在しない場合はfalseを返す', async () => {
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: null,
          error: null,
        }),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };

      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never);

      const result = await hasScope('123456789', 'user:write:chat');
      expect(result).toBe(false);
    });
  });

  describe('validateTokenScopes', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
      global.fetch = vi.fn();
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('トークンが有効(期限内)でスコープを含む場合、スコープ配列を返す', async () => {
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            twitch_access_token: 'valid-token',
            twitch_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
          },
          error: null,
        }),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };
      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never);

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ scopes: ['user:read:email', 'user:write:chat'] }),
      } as Response);

      const result = await validateTokenScopes('123456789');
      expect(result).toEqual(['user:read:email', 'user:write:chat']);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://id.twitch.tv/oauth2/validate',
        { headers: { 'Authorization': 'OAuth valid-token' } },
      );
    });

    it('トークンが期限切れの場合、Twitch APIを叩かずnullを返す（DB信頼にフォールバック）', async () => {
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            twitch_access_token: 'expired-token',
            twitch_token_expires_at: new Date(Date.now() - 1000).toISOString(),
          },
          error: null,
        }),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };
      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never);

      const result = await validateTokenScopes('123456789');
      expect(result).toBeNull();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('期限内トークンが無効(401/revoke)の場合、空配列を返す（乖離検出）', async () => {
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            twitch_access_token: 'revoked-token',
            twitch_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
          },
          error: null,
        }),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };
      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never);

      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ message: 'invalid access token' }),
      } as Response);

      const result = await validateTokenScopes('123456789');
      expect(result).toEqual([]);
    });

    it('twitch_token_expires_atがnullの場合、Twitch APIで検証する', async () => {
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            twitch_access_token: 'token-no-expiry',
            twitch_token_expires_at: null,
          },
          error: null,
        }),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };
      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never);

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ scopes: ['user:read:email'] }),
      } as Response);

      const result = await validateTokenScopes('123456789');
      expect(result).toEqual(['user:read:email']);
      expect(global.fetch).toHaveBeenCalled();
    });

    it('Twitch API 5xxの場合、nullを返す（DB信頼にフォールバック）', async () => {
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            twitch_access_token: 'valid-token',
            twitch_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
          },
          error: null,
        }),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };
      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never);

      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      } as Response);

      const result = await validateTokenScopes('123456789');
      expect(result).toBeNull();
    });

    it('アクセストークンがない場合、nullを返す', async () => {
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: null,
          error: null,
        }),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };
      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never);

      const result = await validateTokenScopes('123456789');
      expect(result).toBeNull();
      // fetch は呼ばれない
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('DBエラー時はnullを返す（例外をスローしない）', async () => {
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: null,
          error: { code: 'PGRST000', message: 'Connection failed' },
        }),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };
      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never);

      const result = await validateTokenScopes('123456789');
      expect(result).toBeNull();
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('refreshTwitchAccessToken - スコープ同期', () => {
    it('リフレッシュ時にtokenとscopeを1回のCAS UPDATEで保存する', async () => {
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn()
          // 初回は期限切れトークンの読み取り。
          .mockResolvedValueOnce({
            data: {
              twitch_access_token: 'expired-token',
              twitch_refresh_token: 'refresh-token',
              twitch_token_expires_at: new Date(Date.now() - 3600000).toISOString(),
            },
            error: null,
          })
          // CAS update が成功したときは、select で更新済み行が返る。
          .mockResolvedValueOnce({ data: { twitch_access_token: 'new-token' }, error: null }),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };

      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never);
      vi.mocked(refreshTwitchToken).mockResolvedValue({
        access_token: 'new-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
        token_type: 'bearer',
        scope: ['user:read:email', 'user:write:chat'],
      });

      const token = await getTwitchAccessToken('123456789');
      expect(token).toBe('new-token');

      expect(mockSupabaseAdmin.update).toHaveBeenCalledTimes(1);
      expect(mockSupabaseAdmin.update).toHaveBeenCalledWith({
        twitch_access_token: 'new-token',
        twitch_refresh_token: 'new-refresh-token',
        twitch_token_expires_at: expect.any(String),
        twitch_scopes: ['user:read:email', 'user:write:chat'],
      });
    });

    it('token/scopeのCAS保存失敗はrefresh失敗とし、無条件の後続scope UPDATEを行わない', async () => {
      const expiredRow = {
        twitch_access_token: 'expired-token',
        twitch_refresh_token: 'refresh-token',
        twitch_token_expires_at: new Date(Date.now() - 3600000).toISOString(),
      };
      const readBuilder: any = {
        select: vi.fn(() => readBuilder),
        eq: vi.fn(() => readBuilder),
        maybeSingle: vi.fn().mockResolvedValue({ data: expiredRow, error: null }),
      };
      const refreshBuilder: any = {
        update: vi.fn(() => refreshBuilder),
        eq: vi.fn(() => refreshBuilder),
        select: vi.fn(() => refreshBuilder),
        maybeSingle: vi.fn().mockResolvedValue({
          data: null,
          error: { code: 'PGRST000', message: 'Connection failed' },
        }),
      };
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn()
          .mockReturnValueOnce(readBuilder)
          .mockReturnValueOnce(refreshBuilder),
        select: vi.fn(),
        eq: vi.fn(),
        update: vi.fn(),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };

      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never);
      vi.mocked(refreshTwitchToken).mockResolvedValue({
        access_token: 'new-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
        token_type: 'bearer',
        scope: ['user:read:email', 'user:write:chat'],
      });

      await expect(getTwitchAccessToken('123456789')).rejects.toMatchObject({
        code: 'REFRESH_FAILED',
      });
      expect(mockSupabaseAdmin.from).toHaveBeenCalledTimes(2);
      expect(refreshBuilder.update).toHaveBeenCalledTimes(1);
      expect(refreshBuilder.update).toHaveBeenCalledWith({
        twitch_access_token: 'new-token',
        twitch_refresh_token: 'new-refresh-token',
        twitch_token_expires_at: expect.any(String),
        twitch_scopes: ['user:read:email', 'user:write:chat'],
      });
    });

    it('リフレッシュレスポンスのスコープでDBが全置換される（マージではない）', async () => {
      // DBに user:write:chat があるが、リフレッシュレスポンスには含まれないケース
      // 全置換により、DBのstaleなスコープが除去されDB/トークン乖離が解消される
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn()
          .mockResolvedValueOnce({
            data: {
              twitch_access_token: 'expired-token',
              twitch_refresh_token: 'refresh-token',
              twitch_token_expires_at: new Date(Date.now() - 3600000).toISOString(),
            },
            error: null,
          })
          .mockResolvedValueOnce({ data: { twitch_access_token: 'new-token' }, error: null }),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };

      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never);
      vi.mocked(refreshTwitchToken).mockResolvedValue({
        access_token: 'new-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
        token_type: 'bearer',
        // リフレッシュレスポンスには基本スコープのみ（user:write:chatなし）
        scope: ['user:read:email', 'channel:read:redemptions'],
      });

      const token = await getTwitchAccessToken('123456789');
      expect(token).toBe('new-token');

      // 全置換scopeもtokenと同じCASに含め、古いrefresh処理から後続UPDATEしない。
      expect(mockSupabaseAdmin.update).toHaveBeenCalledTimes(1);
      expect(mockSupabaseAdmin.update).toHaveBeenCalledWith({
        twitch_access_token: 'new-token',
        twitch_refresh_token: 'new-refresh-token',
        twitch_token_expires_at: expect.any(String),
        twitch_scopes: ['user:read:email', 'channel:read:redemptions'],
      });
    });

    it('リフレッシュレスポンスのスコープが空なら同じCAS UPDATEへ空配列を保存する', async () => {
      const updateMock = vi.fn().mockReturnThis();
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            twitch_access_token: 'expired-token',
            twitch_refresh_token: 'refresh-token',
            twitch_token_expires_at: new Date(Date.now() - 3600000).toISOString(),
          },
          error: null,
        }),
        update: updateMock,
        insert: vi.fn().mockResolvedValue({ error: null }),
      };

      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabaseAdmin as never);
      vi.mocked(refreshTwitchToken).mockResolvedValue({
        access_token: 'new-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
        token_type: 'bearer',
        scope: [], // 空スコープ
      });

      await getTwitchAccessToken('123456789');

      // scope が空でも別UPDATEへ分けず、tokenと同じCASでDB状態を全置換する。
      expect(updateMock).toHaveBeenCalledTimes(1);
      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          twitch_access_token: 'new-token',
          twitch_scopes: [],
        })
      );
    });
  });
});
