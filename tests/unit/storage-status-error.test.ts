/**
 * #1356: GET /api/storage-status の例外委譲契約を固定する。
 *
 * storage usage の取得失敗を route 内で成功扱いへ握りつぶすと、監視記録と利用者への
 * 500 応答が同時に失われる。error reporter 自体の副作用はこの unit test では起動せず、
 * API 境界が共通の handleApiError へ元の例外と context を渡し、その Response を返す
 * ところだけを独立して検証する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET } from '@/app/api/storage-status/route';
import { getSession, canUseStreamerFeatures } from '@/lib/session';
import { getStorageUsage } from '@/lib/storage-usage';
import { sha256Prefix } from '@/lib/crypto-utils';
import { handleApiError } from '@/lib/error-handler';
import type { SessionPayload } from '@/lib/session-cookie';

vi.mock('@/lib/session');
vi.mock('@/lib/storage-usage', () => ({
  getStorageUsage: vi.fn(),
  formatBytes: vi.fn(),
}));
vi.mock('@/lib/crypto-utils', () => ({
  sha256Prefix: vi.fn(),
}));
vi.mock('@/lib/error-handler', () => ({
  handleApiError: vi.fn(),
}));

const mockGetSession = vi.mocked(getSession);
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures);
const mockGetStorageUsage = vi.mocked(getStorageUsage);
const mockSha256Prefix = vi.mocked(sha256Prefix);
const mockHandleApiError = vi.mocked(handleApiError);

const SESSION: SessionPayload = {
  twitchUserId: 'storage-error-user',
  twitchUsername: 'storage-error-user',
  twitchDisplayName: 'Storage Error User',
  twitchProfileImageUrl: '',
  broadcasterType: 'affiliate',
  expiresAt: 4_102_444_800_000,
  version: 1,
};

describe('GET /api/storage-status: error delegation (#1356)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(SESSION);
    mockCanUseStreamerFeatures.mockReturnValue(true);
    mockSha256Prefix.mockResolvedValue('storage-error-prefix');
    mockHandleApiError.mockResolvedValue(
      NextResponse.json({ error: 'handled-storage-error' }, { status: 500 })
    );
  });

  it('storage usage 取得失敗を共通ハンドラへ委譲し、その応答を返す', async () => {
    const error = new Error('storage unavailable');
    mockGetStorageUsage.mockRejectedValue(error);

    const response = await GET();

    expect(mockGetStorageUsage).toHaveBeenCalledWith(
      'storage-error-prefix',
      SESSION.twitchUserId
    );
    expect(mockHandleApiError).toHaveBeenCalledTimes(1);
    expect(mockHandleApiError).toHaveBeenCalledWith(error, 'Storage Status API');
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'handled-storage-error' });
  });
});
