import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import { POST } from '@/app/api/upload/route'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { checkRateLimit } from '@/lib/rate-limit'
import { getFileTypeFromBuffer } from '@/lib/file-utils'
import { validateCSRFToken } from '@/lib/csrf'
import { uploadToR2WithRetry } from '@/lib/r2-client'

// Mock dependencies
vi.mock('next/headers')
vi.mock('@/lib/session')
vi.mock('@/lib/rate-limit')
vi.mock('@/lib/csrf')
// Mock R2 client for upload functionality
// R2クライアントをモックしてアップロード機能をテスト
vi.mock('@/lib/r2-client', () => ({
  uploadToR2WithRetry: vi.fn(),
}))
// Mock storage-db to avoid unmocked supabase/admin dependency
// ストレージDBをモックしてsupabase/adminの未モック依存を回避
vi.mock('@/lib/storage-db', () => ({
  recordBlobFile: vi.fn().mockResolvedValue(undefined),
}))
// Mock storage-usage to provide storage limit info
vi.mock('@/lib/storage-usage', () => ({
  getStorageUsage: vi.fn().mockResolvedValue({
    userUsage: 0,
    globalUsage: 0,
    userLimitReached: false,
    globalLimitReached: false,
    userLimitBytes: 100 * 1024 * 1024,
    globalLimitBytes: 1000 * 1024 * 1024,
  }),
}))

const mockCookies = vi.mocked(cookies)
const mockGetSession = vi.mocked(getSession)
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures)
const mockCheckRateLimit = vi.mocked(checkRateLimit)
const mockUploadToR2WithRetry = vi.mocked(uploadToR2WithRetry)
const mockValidateCSRFToken = vi.mocked(validateCSRFToken)

describe('POST /api/upload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Mock CSRF validation to pass by default
    mockValidateCSRFToken.mockResolvedValue({ valid: true })
    // 既存テストは配信者セッションを前提としているため、デフォルトはtrueにする
    // （配信者権限なしのケースは専用テストで個別にfalseへ上書きする）
    mockCanUseStreamerFeatures.mockReturnValue(true)
    // Mock cookies to return empty store
    mockCookies.mockResolvedValue({
      get: vi.fn().mockReturnValue(undefined),
    } as unknown as Awaited<ReturnType<typeof cookies>>)
    // Mock rate limit to pass by default
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Date.now() + 60000,
    })
  })

  describe('レート制限', () => {
    it('レート制限超過で 429 エラーを返す', async () => {
      mockGetSession.mockResolvedValue(null)
      mockCheckRateLimit.mockResolvedValue({
        success: false,
        limit: 10,
        remaining: 0,
        reset: Date.now() + 60000,
      })

      const formData = new FormData()
      const request = new NextRequest('http://localhost:3000/api/upload', {
        method: 'POST',
        body: formData,
      })

      const response = await POST(request)

      expect(response.status).toBe(429)
      const body = await response.json()
      expect(body.error).toBe('Too many requests. Please try again later.')
      expect(body.retryAfter).toBeDefined()
    })
  })

  describe('認証なしのリクエスト', () => {
    it('401 エラーを返す', async () => {
      mockGetSession.mockResolvedValue(null)

      const formData = new FormData()
      const request = new NextRequest('http://localhost:3000/api/upload', {
        method: 'POST',
        body: formData,
      })

      const response = await POST(request)

      expect(response.status).toBe(401)
      const body = await response.json()
      expect(body.error).toBe('Not authenticated')
    })
  })

  describe('配信者権限のないセッション', () => {
    it('403 エラーを返す(#832: 誰でも公開R2へアップロードできる問題の修正)', async () => {
      mockGetSession.mockResolvedValue({
        twitchUserId: 'test-user-id',
        twitchUsername: 'test-user',
        twitchDisplayName: 'Test User',
        twitchProfileImageUrl: 'https://example.com/avatar.jpg',
        broadcasterType: '',
        expiresAt: Date.now() + 3600000,
        version: 1,
      })
      mockCanUseStreamerFeatures.mockReturnValue(false)

      const imageFile = new File([createMinimalJpegBuffer()], 'test.jpg', {
        type: 'image/jpeg',
      })
      const formData = new FormData()
      formData.append('file', imageFile)

      const request = new NextRequest('http://localhost:3000/api/upload', {
        method: 'POST',
        body: formData,
      })

      const response = await POST(request)

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('Forbidden')
      expect(mockUploadToR2WithRetry).not.toHaveBeenCalled()
    })
  })

  describe('ファイルなしのリクエスト', () => {
    it('400 エラーを返す', async () => {
      mockGetSession.mockResolvedValue({
        twitchUserId: 'test-user-id',
        twitchUsername: 'test-user',
        twitchDisplayName: 'Test User',
        twitchProfileImageUrl: 'https://example.com/avatar.jpg',
        broadcasterType: '',
        expiresAt: Date.now() + 3600000,
        version: 1,
      })

      const formData = new FormData()
      const request = new NextRequest('http://localhost:3000/api/upload', {
        method: 'POST',
        body: formData,
      })

      const response = await POST(request)

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toBe('No file selected')
    })
  })

  describe('ファイルサイズ制限', () => {
    it('1MB を超えるファイルは 400 エラーを返す', async () => {
      mockGetSession.mockResolvedValue({
        twitchUserId: 'test-user-id',
        twitchUsername: 'test-user',
        twitchDisplayName: 'Test User',
        twitchProfileImageUrl: 'https://example.com/avatar.jpg',
        broadcasterType: '',
        expiresAt: Date.now() + 3600000,
        version: 1,
      })

      const largeFile = new File([new ArrayBuffer(1 * 1024 * 1024 + 1)], 'large.jpg', {
        type: 'image/jpeg',
      })

      const formData = new FormData()
      formData.append('file', largeFile)

      const request = new NextRequest('http://localhost:3000/api/upload', {
        method: 'POST',
        body: formData,
      })

      const response = await POST(request)

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toBe('File size exceeds the maximum allowed size')
    })
  })

  describe('ファイルタイプ検証', () => {
    it('不正なファイルタイプは 400 エラーを返す', async () => {
      mockGetSession.mockResolvedValue({
        twitchUserId: 'test-user-id',
        twitchUsername: 'test-user',
        twitchDisplayName: 'Test User',
        twitchProfileImageUrl: 'https://example.com/avatar.jpg',
        broadcasterType: '',
        expiresAt: Date.now() + 3600000,
        version: 1,
      })

      const textFile = new File(['This is text'], 'test.txt', {
        type: 'text/plain',
      })

      const formData = new FormData()
      formData.append('file', textFile)

      const request = new NextRequest('http://localhost:3000/api/upload', {
        method: 'POST',
        body: formData,
      })

      const response = await POST(request)

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toBe('Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed')
    })
  })

  describe('マジックバイト検証', () => {
    it('拡張子がJPEGだが内容がJPEGでない場合 400 エラーを返す', async () => {
      mockGetSession.mockResolvedValue({
        twitchUserId: 'test-user-id',
        twitchUsername: 'test-user',
        twitchDisplayName: 'Test User',
        twitchProfileImageUrl: 'https://example.com/avatar.jpg',
        broadcasterType: '',
        expiresAt: Date.now() + 3600000,
        version: 1,
      })

      const invalidFile = new File([Buffer.from([0x00, 0x00, 0x00])], 'fake.jpg', {
        type: 'image/jpeg',
      })

      const formData = new FormData()
      formData.append('file', invalidFile)

      const request = new NextRequest('http://localhost:3000/api/upload', {
        method: 'POST',
        body: formData,
      })

      const response = await POST(request)

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toBe('File content does not match extension')
    })

    it('拡張子がPNGだが内容がJPEGの場合 400 エラーを返す', async () => {
      mockGetSession.mockResolvedValue({
        twitchUserId: 'test-user-id',
        twitchUsername: 'test-user',
        twitchDisplayName: 'Test User',
        twitchProfileImageUrl: 'https://example.com/avatar.jpg',
        broadcasterType: '',
        expiresAt: Date.now() + 3600000,
        version: 1,
      })

      const jpegFile = new File([createMinimalJpegBuffer()], 'fake.png', {
        type: 'image/png',
      })

      const formData = new FormData()
      formData.append('file', jpegFile)

      const request = new NextRequest('http://localhost:3000/api/upload', {
        method: 'POST',
        body: formData,
      })

      const response = await POST(request)

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toBe('File content does not match extension')
    })
  })

  describe('正常な画像アップロード', () => {
    it('JPEG画像のアップロードに成功する', async () => {
      mockGetSession.mockResolvedValue({
        twitchUserId: 'test-user-id',
        twitchUsername: 'test-user',
        twitchDisplayName: 'Test User',
        twitchProfileImageUrl: 'https://example.com/avatar.jpg',
        broadcasterType: '',
        expiresAt: Date.now() + 3600000,
        version: 1,
      })

      mockUploadToR2WithRetry.mockResolvedValue({
        url: 'https://blob.vercel-storage.com/test-image.jpg',
      })

      const imageFile = new File([createMinimalJpegBuffer()], 'test.jpg', {
        type: 'image/jpeg',
      })

      const formData = new FormData()
      formData.append('file', imageFile)

      const request = new NextRequest('http://localhost:3000/api/upload', {
        method: 'POST',
        body: formData,
      })

      const response = await POST(request)

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.url).toBe('https://blob.vercel-storage.com/test-image.jpg')
      expect(mockUploadToR2WithRetry).toHaveBeenCalled()
      // First argument should be the filename pattern
      // Filename format: {userPrefix(8chars)}_{uniqueSuffix(UUID)}.{ext}
      // uniqueSuffixはcrypto.randomUUID()で生成する推測不能な値 (#832)
      // 第1引数はファイル名パターン
      expect(mockUploadToR2WithRetry.mock.calls[0][0]).toMatch(
        /^[a-f0-9]{8}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/
      )
      // Second argument should be Buffer or Uint8Array-like (file contents)
      // 第2引数はファイル内容のBuffer
      const fileArg = mockUploadToR2WithRetry.mock.calls[0][1]
      expect(fileArg).toBeDefined()
      expect(fileArg.length).toBeGreaterThan(0)
      // Third argument should be the contentType (R2 upload uses contentType, not options)
      // 第3引数はcontentType（R2アップロードはoptionsではなくcontentTypeを使用）
      expect(mockUploadToR2WithRetry.mock.calls[0][2]).toBe('image/jpeg')
    })

    it('PNG画像のアップロードに成功する', async () => {
      mockGetSession.mockResolvedValue({
        twitchUserId: 'test-user-id',
        twitchUsername: 'test-user',
        twitchDisplayName: 'Test User',
        twitchProfileImageUrl: 'https://example.com/avatar.jpg',
        broadcasterType: '',
        expiresAt: Date.now() + 3600000,
        version: 1,
      })

      mockUploadToR2WithRetry.mockResolvedValue({
        url: 'https://blob.vercel-storage.com/test-image.png',
      })

      const imageFile = new File([createMinimalPngBuffer()], 'test.png', {
        type: 'image/png',
      })

      const formData = new FormData()
      formData.append('file', imageFile)

      const request = new NextRequest('http://localhost:3000/api/upload', {
        method: 'POST',
        body: formData,
      })

      const response = await POST(request)

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.url).toBe('https://blob.vercel-storage.com/test-image.png')
    })

    it('GIF画像のアップロードに成功する', async () => {
      mockGetSession.mockResolvedValue({
        twitchUserId: 'test-user-id',
        twitchUsername: 'test-user',
        twitchDisplayName: 'Test User',
        twitchProfileImageUrl: 'https://example.com/avatar.jpg',
        broadcasterType: '',
        expiresAt: Date.now() + 3600000,
        version: 1,
      })

      mockUploadToR2WithRetry.mockResolvedValue({
        url: 'https://blob.vercel-storage.com/test-image.gif',
      })

      const imageFile = new File([createMinimalGifBuffer()], 'test.gif', {
        type: 'image/gif',
      })

      const formData = new FormData()
      formData.append('file', imageFile)

      const request = new NextRequest('http://localhost:3000/api/upload', {
        method: 'POST',
        body: formData,
      })

      const response = await POST(request)

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.url).toBe('https://blob.vercel-storage.com/test-image.gif')
    })

    it('GIF89a画像（アニメーションGIF）のアップロードに成功する', async () => {
      // 回帰テスト: アニメーション GIF の主流バージョンである GIF89a が
      // マジックナンバー判定で拒否されないことを保証する。
      mockGetSession.mockResolvedValue({
        twitchUserId: 'test-user-id',
        twitchUsername: 'test-user',
        twitchDisplayName: 'Test User',
        twitchProfileImageUrl: 'https://example.com/avatar.jpg',
        broadcasterType: '',
        expiresAt: Date.now() + 3600000,
        version: 1,
      })

      mockUploadToR2WithRetry.mockResolvedValue({
        url: 'https://blob.vercel-storage.com/test-image-89a.gif',
      })

      const imageFile = new File([createMinimalGif89aBuffer()], 'test.gif', {
        type: 'image/gif',
      })

      const formData = new FormData()
      formData.append('file', imageFile)

      const request = new NextRequest('http://localhost:3000/api/upload', {
        method: 'POST',
        body: formData,
      })

      const response = await POST(request)

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.url).toBe('https://blob.vercel-storage.com/test-image-89a.gif')
      expect(mockUploadToR2WithRetry).toHaveBeenCalled()
      expect(mockUploadToR2WithRetry.mock.calls[0][2]).toBe('image/gif')
    })
  })

  describe('Vercel Blob エラー時', () => {
    it('500 エラーを返す', async () => {
      mockGetSession.mockResolvedValue({
        twitchUserId: 'test-user-id',
        twitchUsername: 'test-user',
        twitchDisplayName: 'Test User',
        twitchProfileImageUrl: 'https://example.com/avatar.jpg',
        broadcasterType: '',
        expiresAt: Date.now() + 3600000,
        version: 1,
      })

      mockUploadToR2WithRetry.mockRejectedValue(new Error('Vercel Blob error'))

      const imageFile = new File([createMinimalJpegBuffer()], 'test.jpg', {
        type: 'image/jpeg',
      })

      const formData = new FormData()
      formData.append('file', imageFile)

      const request = new NextRequest('http://localhost:3000/api/upload', {
        method: 'POST',
        body: formData,
      })

      const response = await POST(request)

      expect(response.status).toBe(500)
      const body = await response.json()
      expect(body.error).toBe('Internal server error')
    })
  })
})

function createMinimalJpegBuffer(): ArrayBuffer {
  const header = new Uint8Array([
    0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46,
    0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
    0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9
  ])
  return header.buffer
}

function createMinimalPngBuffer(): ArrayBuffer {
  const header = new Uint8Array([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52
  ])
  return header.buffer
}

function createMinimalGifBuffer(): ArrayBuffer {
  // GIF87a シグネチャ
  const header = new Uint8Array([
    0x47, 0x49, 0x46, 0x38, 0x37, 0x61
  ])
  return header.buffer
}

function createMinimalGif89aBuffer(): ArrayBuffer {
  // GIF89a シグネチャ（アニメーション GIF などで一般的に使われるバージョン）
  const header = new Uint8Array([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61
  ])
  return header.buffer
}

describe('getFileTypeFromBuffer', () => {
  it('JPEGファイルを正しく識別する', () => {
    const jpegBuffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46])
    expect(getFileTypeFromBuffer(jpegBuffer)).toBe('image/jpeg')
  })

  it('PNGファイルを正しく識別する', () => {
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    expect(getFileTypeFromBuffer(pngBuffer)).toBe('image/png')
  })

  it('GIF87aファイルを正しく識別する', () => {
    const gifBuffer = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
    expect(getFileTypeFromBuffer(gifBuffer)).toBe('image/gif')
  })

  it('GIF89aファイルを正しく識別する（アニメーションGIFで一般的）', () => {
    // Regression test: 元実装は GIF87a (バイト4=0x37) のみを許容していたため、
    // 一般的に流通する GIF89a (バイト4=0x39) が application/octet-stream に
    // 落ちて拒否される致命的バグがあった。両バージョンを許容することを確認する。
    const gif89aBuffer = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
    expect(getFileTypeFromBuffer(gif89aBuffer)).toBe('image/gif')
  })

  it('GIFバージョンバイトが不正な場合は拒否する', () => {
    // 0x37/0x39 以外のバージョン文字は GIF として認めない
    const invalidGifBuffer = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x30, 0x61])
    expect(getFileTypeFromBuffer(invalidGifBuffer)).toBe('application/octet-stream')
  })

  it('WebPファイルを正しく識別する', () => {
    const webpBuffer = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50])
    expect(getFileTypeFromBuffer(webpBuffer)).toBe('image/webp')
  })

  it('不明なファイルタイプを返す', () => {
    const unknownBuffer = Buffer.from([0x00, 0x00, 0x00, 0x00])
    expect(getFileTypeFromBuffer(unknownBuffer)).toBe('application/octet-stream')
  })

  it('短いバッファを処理する', () => {
    const shortBuffer = Buffer.from([0xFF])
    expect(getFileTypeFromBuffer(shortBuffer)).toBe('application/octet-stream')
  })
})