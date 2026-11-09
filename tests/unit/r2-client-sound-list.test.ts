/**
 * #1907: 未使用効果音の回収ジョブが使う listSoundObjects の契約テスト。
 *
 * Workers のネイティブ binding は単体テストで再現できないため、ローカル開発と
 * 同じ S3 SDK フォールバック経路を検証する（ページング・正規化・上限・環境変数）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const s3 = vi.hoisted(() => ({
  send: vi.fn(),
}))

const cf = vi.hoisted(() => ({
  binding: null as null | {
    list: ReturnType<typeof vi.fn>
    delete: ReturnType<typeof vi.fn>
    put: ReturnType<typeof vi.fn>
  },
}))

vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: vi.fn(async () => ({
    env: { R2_SOUNDS: cf.binding },
  })),
}))
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = s3.send
  },
  ListObjectsV2Command: class {
    input: unknown
    constructor(input: unknown) {
      this.input = input
    }
  },
}))
vi.mock('@/lib/logger.server', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { listSoundObjects } from '@/lib/r2-client'

describe('listSoundObjects (#1907)', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    cf.binding = null
    process.env = { ...originalEnv }
    process.env.R2_SOUND_BUCKET_NAME = 'sound-bucket'
    process.env.R2_ENDPOINT = 'https://r2.example.com'
    process.env.R2_SOUND_ACCESS_KEY_ID = 'key'
    process.env.R2_SOUND_SECRET_ACCESS_KEY = 'secret'
  })

  it('Workers ネイティブ binding の list を cursor で辿る', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        objects: [{ key: 'sound_a.wav', size: 10, uploaded: new Date('2026-10-01T00:00:00Z') }],
        truncated: true,
        cursor: 'next',
      })
      .mockResolvedValueOnce({
        objects: [{ key: 'sound_b.wav', size: 20, uploaded: new Date('2026-10-02T00:00:00Z') }],
        truncated: false,
      })
    cf.binding = { list, delete: vi.fn(), put: vi.fn() }

    const result = await listSoundObjects()

    expect(result.objects.map((object) => object.key)).toEqual(['sound_a.wav', 'sound_b.wav'])
    expect(list).toHaveBeenNthCalledWith(1, { prefix: 'sound_', cursor: undefined, limit: 1000 })
    expect(list).toHaveBeenNthCalledWith(2, { prefix: 'sound_', cursor: 'next', limit: 1000 })
  })

  it('S3 のページングを辿り、キー・サイズ・更新日時へ正規化する', async () => {
    s3.send
      .mockResolvedValueOnce({
        Contents: [
          { Key: 'sound_a.wav', Size: 10, LastModified: new Date('2026-10-01T00:00:00Z') },
          { Key: 'sound_b.wav', Size: 20, LastModified: new Date('2026-10-02T00:00:00Z') },
        ],
        IsTruncated: true,
        NextContinuationToken: 'next',
      })
      .mockResolvedValueOnce({
        Contents: [
          { Key: 'sound_c.wav', Size: 30, LastModified: new Date('2026-10-03T00:00:00Z') },
        ],
        IsTruncated: false,
      })

    const result = await listSoundObjects()

    expect(result.truncated).toBe(false)
    expect(result.objects).toEqual([
      { key: 'sound_a.wav', size: 10, uploaded: new Date('2026-10-01T00:00:00Z') },
      { key: 'sound_b.wav', size: 20, uploaded: new Date('2026-10-02T00:00:00Z') },
      { key: 'sound_c.wav', size: 30, uploaded: new Date('2026-10-03T00:00:00Z') },
    ])
    expect(s3.send).toHaveBeenCalledTimes(2)
  })

  it('maxObjects に達したら打ち切り、truncated=true を返す', async () => {
    s3.send.mockResolvedValueOnce({
      Contents: [
        { Key: 'sound_a.wav', Size: 10, LastModified: new Date() },
        { Key: 'sound_b.wav', Size: 20, LastModified: new Date() },
        { Key: 'sound_c.wav', Size: 30, LastModified: new Date() },
      ],
      IsTruncated: false,
    })

    const result = await listSoundObjects({ maxObjects: 2 })

    expect(result.objects).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })

  it('IsTruncated=true で token が無い場合も truncated=true を返す', async () => {
    s3.send.mockResolvedValueOnce({
      Contents: [{ Key: 'sound_a.wav', Size: 10, LastModified: new Date() }],
      IsTruncated: true,
    })

    const result = await listSoundObjects()

    expect(result.truncated).toBe(true)
  })

  it('LastModified が無いオブジェクトは uploaded=null（回収側で fail-closed）', async () => {
    s3.send.mockResolvedValueOnce({
      Contents: [{ Key: 'sound_unknown.wav', Size: 1 }],
      IsTruncated: false,
    })

    await expect(listSoundObjects()).resolves.toEqual({
      objects: [{ key: 'sound_unknown.wav', size: 1, uploaded: null }],
      truncated: false,
    })
  })

  it('環境変数不足は throw する（黙って空一覧を返さない）', async () => {
    delete process.env.R2_SOUND_BUCKET_NAME

    await expect(listSoundObjects()).rejects.toThrow(/R2_SOUND_BUCKET_NAME/)
  })

  it('S3 エラーは throw する', async () => {
    s3.send.mockRejectedValueOnce(new Error('s3 down'))

    await expect(listSoundObjects()).rejects.toThrow('s3 down')
  })
})
