/**
 * #830: ストレージURL判定と所有権判定のテスト
 *
 * `/api/upload/delete` と `/api/cards/[id]` の削除経路は、この2つの判定に
 * 依存して「自分のオブジェクトだけを削除する」ことを保証している。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isR2Url,
  isVercelBlobUrl,
  isStorageUrl,
  getR2KeyFromUrl,
  isOwnedStorageUrl,
  isAssignableImageUrl,
} from '@/lib/storage-utils';
import { sha256Prefix } from '@/lib/crypto-utils';
import { getR2PublicUrl } from '@/lib/r2-client';

// storage-utils は R2 の公開URLだけを r2-client から取得する。
// R2バインディング/S3 SDKを読み込まないようモジュールごと差し替える。
vi.mock('@/lib/r2-client', () => ({
  getR2PublicUrl: vi.fn(() => 'https://images.example.test'),
}));

const mockGetR2PublicUrl = vi.mocked(getR2PublicUrl);

const OWNER = 'owner-user-id';
const ATTACKER = 'attacker-user-id';

describe('isR2Url (#830)', () => {
  beforeEach(() => {
    mockGetR2PublicUrl.mockReturnValue('https://images.example.test');
  });

  it('R2_PUBLIC_URL と同一originのURLのみ true を返す', () => {
    expect(isR2Url('https://images.example.test/abc12345_def67890.png')).toBe(true);
  });

  it('他バケットの .r2.dev URL を拒否する（自バケットの任意キー削除を防ぐ）', () => {
    expect(isR2Url('https://attacker-bucket.r2.dev/abc12345_def67890.png')).toBe(false);
    expect(isR2Url('https://any.r2.cloudflarestorage.com/abc12345_def67890.png')).toBe(false);
  });

  it('公開URLホストを接頭辞に持つだけの別ドメインを拒否する', () => {
    expect(isR2Url('https://images.example.test.evil.example/abc12345_x.png')).toBe(false);
  });

  it('公開URLを文字列として含むだけのURLを拒否する', () => {
    expect(isR2Url('https://evil.example/?u=https://images.example.test/abc12345_x.png')).toBe(false);
  });

  it('R2_PUBLIC_URL が未設定の環境では false を返す（fail-closed）', () => {
    mockGetR2PublicUrl.mockImplementation(() => {
      throw new Error('Missing R2_PUBLIC_URL environment variable');
    });
    expect(isR2Url('https://images.example.test/abc12345_x.png')).toBe(false);
  });

  it('空文字列やURLとして不正な値は false', () => {
    expect(isR2Url('')).toBe(false);
    expect(isR2Url('not a url')).toBe(false);
  });
});

describe('isVercelBlobUrl (#830)', () => {
  it('Vercel Blob のホストのみ true を返す', () => {
    expect(isVercelBlobUrl('https://abc.public.blob.vercel-storage.com/x.png')).toBe(true);
    expect(isVercelBlobUrl('https://blob.vercel-storage.com/x.png')).toBe(true);
  });

  it('ホスト名以外に文字列を含むだけのURLを拒否する', () => {
    expect(isVercelBlobUrl('https://evil.example/?u=blob.vercel-storage.com')).toBe(false);
    expect(isVercelBlobUrl('https://blob.vercel-storage.com.evil.example/x.png')).toBe(false);
  });
});

describe('isStorageUrl (#830)', () => {
  beforeEach(() => {
    mockGetR2PublicUrl.mockReturnValue('https://images.example.test');
  });

  it('外部CDN（Twitchエモート）はストレージURLではない', () => {
    expect(isStorageUrl('https://static-cdn.jtvnw.net/emoticons/v2/1/static/light/3.0')).toBe(false);
  });
});

describe('isOwnedStorageUrl (#830)', () => {
  beforeEach(() => {
    mockGetR2PublicUrl.mockReturnValue('https://images.example.test');
  });

  it('自分のプレフィックスで始まるキーは true', async () => {
    const prefix = await sha256Prefix(OWNER);
    expect(await isOwnedStorageUrl(`https://images.example.test/${prefix}_deadbeef.png`, OWNER)).toBe(true);
  });

  it('他人のプレフィックスのキーは false', async () => {
    const victimPrefix = await sha256Prefix(OWNER);
    expect(
      await isOwnedStorageUrl(`https://images.example.test/${victimPrefix}_deadbeef.png`, ATTACKER)
    ).toBe(false);
  });

  it('自分のプレフィックスを含むだけのネストキーは false（検証対象と削除対象のズレを防ぐ）', async () => {
    const attackerPrefix = await sha256Prefix(ATTACKER);
    const url = `https://images.example.test/victim-dir/${attackerPrefix}_deadbeef.png`;

    // 削除に渡されるキーはネストされたパス全体であり、攻撃者の所有物ではない
    expect(getR2KeyFromUrl(url)).toBe(`victim-dir/${attackerPrefix}_deadbeef.png`);
    expect(await isOwnedStorageUrl(url, ATTACKER)).toBe(false);
  });

  it('プレフィックスが前方一致するだけでセパレータが無いキーは false', async () => {
    const prefix = await sha256Prefix(OWNER);
    expect(await isOwnedStorageUrl(`https://images.example.test/${prefix}deadbeef.png`, OWNER)).toBe(false);
  });

  it('キーを持たないURLは false', async () => {
    expect(await isOwnedStorageUrl('https://images.example.test/', OWNER)).toBe(false);
    expect(await isOwnedStorageUrl('not a url', OWNER)).toBe(false);
  });
});

describe('isAssignableImageUrl (#830)', () => {
  beforeEach(() => {
    mockGetR2PublicUrl.mockReturnValue('https://images.example.test');
  });

  it('ストレージ外のURL（外部CDN）は許可する', async () => {
    expect(
      await isAssignableImageUrl('https://static-cdn.jtvnw.net/emoticons/v2/1/static/light/3.0', ATTACKER)
    ).toBe(true);
  });

  it('未指定・空文字は許可する（画像なし）', async () => {
    expect(await isAssignableImageUrl(undefined, ATTACKER)).toBe(true);
    expect(await isAssignableImageUrl(null, ATTACKER)).toBe(true);
    expect(await isAssignableImageUrl('  ', ATTACKER)).toBe(true);
  });

  it('自分のストレージURLは許可する', async () => {
    const prefix = await sha256Prefix(OWNER);
    expect(await isAssignableImageUrl(`https://images.example.test/${prefix}_deadbeef.png`, OWNER)).toBe(true);
  });

  it('他人のストレージURLは拒否する', async () => {
    const victimPrefix = await sha256Prefix(OWNER);
    expect(
      await isAssignableImageUrl(`https://images.example.test/${victimPrefix}_deadbeef.png`, ATTACKER)
    ).toBe(false);
  });
});
