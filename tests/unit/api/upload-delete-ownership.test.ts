/**
 * #830: POST /api/upload/delete の所有権検証テスト
 *
 * 修正前は所有権検証が無く、配信者セッションを持つ任意のユーザーが他配信者の
 * カード画像をR2から削除できた（IDOR）。ここでは「他人のオブジェクトに対して
 * DB削除もR2削除も一切実行されない」ことを検証する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/upload/delete/route';
import { getSession, canUseStreamerFeatures } from '@/lib/session';
import { checkRateLimit } from '@/lib/rate-limit';
import { validateCSRFToken } from '@/lib/csrf';
import { removeBlobFile } from '@/lib/storage-db';
import { deleteFromR2 } from '@/lib/r2-client';
import { sha256Prefix } from '@/lib/crypto-utils';

vi.mock('@/lib/session');
vi.mock('@/lib/rate-limit');
vi.mock('@/lib/csrf');
vi.mock('@/lib/storage-db', () => ({
  removeBlobFile: vi.fn(),
}));
vi.mock('@/lib/r2-client', () => ({
  getR2PublicUrl: vi.fn(() => R2_PUBLIC_URL),
  deleteFromR2: vi.fn(),
}));

const R2_PUBLIC_URL = 'https://images.example.test';

const mockGetSession = vi.mocked(getSession);
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures);
const mockCheckRateLimit = vi.mocked(checkRateLimit);
const mockValidateCSRFToken = vi.mocked(validateCSRFToken);
const mockRemoveBlobFile = vi.mocked(removeBlobFile);
const mockDeleteFromR2 = vi.mocked(deleteFromR2);

const SESSION = {
  twitchUserId: 'attacker-user-id',
  twitchUsername: 'attacker',
  twitchDisplayName: 'Attacker',
  twitchProfileImageUrl: '',
  broadcasterType: 'affiliate' as const,
  expiresAt: Date.now() + 60_000,
  version: 1,
};

const VICTIM_USER_ID = 'victim-user-id';

function createRequest(url: unknown): NextRequest {
  return new NextRequest('http://localhost/api/upload/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
}

describe('POST /api/upload/delete: 所有権検証 (#830)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(SESSION);
    mockCanUseStreamerFeatures.mockReturnValue(true);
    mockValidateCSRFToken.mockResolvedValue({ valid: true });
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Date.now() + 60_000,
    });
    mockRemoveBlobFile.mockResolvedValue(null);
    mockDeleteFromR2.mockResolvedValue(undefined);
  });

  it('他配信者のオブジェクトは403で拒否し、DB削除もR2削除も実行しない', async () => {
    const victimPrefix = await sha256Prefix(VICTIM_USER_ID);
    const response = await POST(createRequest(`${R2_PUBLIC_URL}/${victimPrefix}_deadbeef.png`));

    expect(response.status).toBe(403);
    expect(mockRemoveBlobFile).not.toHaveBeenCalled();
    expect(mockDeleteFromR2).not.toHaveBeenCalled();
  });

  it('自分のオブジェクトは従来どおり削除できる', async () => {
    const ownPrefix = await sha256Prefix(SESSION.twitchUserId);
    const url = `${R2_PUBLIC_URL}/${ownPrefix}_deadbeef.png`;

    const response = await POST(createRequest(url));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(mockRemoveBlobFile).toHaveBeenCalledWith(url);
    expect(mockDeleteFromR2).toHaveBeenCalledWith(`${ownPrefix}_deadbeef.png`);
  });

  it('他バケットの .r2.dev URL はストレージURLとして扱わず400で拒否する', async () => {
    const victimPrefix = await sha256Prefix(VICTIM_USER_ID);
    const response = await POST(createRequest(`https://attacker.r2.dev/${victimPrefix}_deadbeef.png`));

    expect(response.status).toBe(400);
    expect(mockRemoveBlobFile).not.toHaveBeenCalled();
    expect(mockDeleteFromR2).not.toHaveBeenCalled();
  });

  it('自分のプレフィックスを含むネストキーでも他キーを削除できない', async () => {
    const ownPrefix = await sha256Prefix(SESSION.twitchUserId);
    const response = await POST(
      createRequest(`${R2_PUBLIC_URL}/victim-dir/${ownPrefix}_deadbeef.png`)
    );

    expect(response.status).toBe(403);
    expect(mockDeleteFromR2).not.toHaveBeenCalled();
  });

  // R2削除の失敗は握りつぶさず500へ落とす（error-reporter が拾えるようにする）。
  // 将来 deleteOwnedStorageImage 内で catch すると「削除できていないのに200」に
  // なるため、その回帰をここで固定する。
  it('R2削除が失敗した場合は500を返す（成功として握りつぶさない）', async () => {
    const ownPrefix = await sha256Prefix(SESSION.twitchUserId);
    mockDeleteFromR2.mockRejectedValue(new Error('R2 unavailable'));

    const response = await POST(createRequest(`${R2_PUBLIC_URL}/${ownPrefix}_deadbeef.png`));

    expect(response.status).toBe(500);
  });

  // Vercel Blob は R2 へ移行済みで実体削除しない。DB記録だけを削除する既存挙動を固定する。
  it('自分のVercel Blob URLはDB記録のみ削除しR2削除は行わない', async () => {
    const ownPrefix = await sha256Prefix(SESSION.twitchUserId);
    const url = `https://abc.public.blob.vercel-storage.com/${ownPrefix}_deadbeef.png`;

    const response = await POST(createRequest(url));

    expect(response.status).toBe(200);
    expect(mockRemoveBlobFile).toHaveBeenCalledWith(url);
    expect(mockDeleteFromR2).not.toHaveBeenCalled();
  });

  it('ストレージ外のURLは400で拒否する', async () => {
    const response = await POST(
      createRequest('https://static-cdn.jtvnw.net/emoticons/v2/1/static/light/3.0')
    );

    expect(response.status).toBe(400);
    expect(mockRemoveBlobFile).not.toHaveBeenCalled();
    expect(mockDeleteFromR2).not.toHaveBeenCalled();
  });

  it('配信者権限のないセッションは従来どおり401', async () => {
    mockCanUseStreamerFeatures.mockReturnValue(false);
    const ownPrefix = await sha256Prefix(SESSION.twitchUserId);

    const response = await POST(createRequest(`${R2_PUBLIC_URL}/${ownPrefix}_deadbeef.png`));

    expect(response.status).toBe(401);
    expect(mockDeleteFromR2).not.toHaveBeenCalled();
  });
});
