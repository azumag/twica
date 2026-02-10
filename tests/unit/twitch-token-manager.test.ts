import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTwitchAccessToken, saveTwitchTokens, deleteTwitchTokens, removeScope } from '@/lib/twitch/token-manager';
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

    it('期限切れのトークンを更新する', async () => {
      const mockSupabaseAdmin: MockSupabaseAdmin = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValueOnce({
          data: {
            twitch_access_token: 'expired-token',
            twitch_refresh_token: 'refresh-token',
            twitch_token_expires_at: new Date(Date.now() - 3600000).toISOString(),
          },
          error: null,
        }),
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
});
