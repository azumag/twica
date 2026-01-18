import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/upload/route'
import { getSession } from '@/lib/session'
import { checkRateLimit } from '@/lib/rate-limit'
import { put } from '@vercel/blob'
import { getFileTypeFromBuffer } from '@/lib/file-utils'

// Mock dependencies
vi.mock('@/lib/session')
vi.mock('@/lib/rate-limit')
vi.mock('@vercel/blob')

const mockGetSession = vi.mocked(getSession)
const mockCheckRateLimit = vi.mocked(checkRateLimit)
const mockPut = vi.mocked(put)

describe('POST /api/upload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

  describe('ファイルなしのリクエスト', () => {
    it('400 エラーを返す', async () => {
      mockGetSession.mockResolvedValue({
        twitchUserId: 'test-user-id',
        twitchUsername: 'test-user',
        twitchDisplayName: 'Test User',
        twitchProfileImageUrl: 'https://example.com/avatar.jpg',
        broadcasterType: '',
        expiresAt: Date.now() + 3600000,
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
      })

      mockPut.mockResolvedValue({
        url: 'https://blob.vercel-storage.com/test-image.jpg',
        downloadUrl: 'https://blob.vercel-storage.com/test-image.jpg',
        pathname: '/test-image.jpg',
        contentType: 'image/jpeg',
        contentDisposition: 'inline; filename="test-image.jpg"',
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
      expect(mockPut).toHaveBeenCalled()
      expect(mockPut).toHaveBeenCalledWith(
        expect.stringMatching(/^[a-f0-9]{16}\.jpg$/),
        expect.any(Buffer),
        { access: 'public' }
      )
    })

    it('PNG画像のアップロードに成功する', async () => {
      mockGetSession.mockResolvedValue({
        twitchUserId: 'test-user-id',
        twitchUsername: 'test-user',
        twitchDisplayName: 'Test User',
        twitchProfileImageUrl: 'https://example.com/avatar.jpg',
        broadcasterType: '',
        expiresAt: Date.now() + 3600000,
      })

      mockPut.mockResolvedValue({
        url: 'https://blob.vercel-storage.com/test-image.png',
        downloadUrl: 'https://blob.vercel-storage.com/test-image.png',
        pathname: '/test-image.png',
        contentType: 'image/png',
        contentDisposition: 'inline; filename="test-image.png"',
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
      })

      mockPut.mockResolvedValue({
        url: 'https://blob.vercel-storage.com/test-image.gif',
        downloadUrl: 'https://blob.vercel-storage.com/test-image.gif',
        pathname: '/test-image.gif',
        contentType: 'image/gif',
        contentDisposition: 'inline; filename="test-image.gif"',
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
      })

      mockPut.mockRejectedValue(new Error('Vercel Blob error'))

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
  const header = new Uint8Array([
    0x47, 0x49, 0x46, 0x38, 0x37, 0x61
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

  it('GIFファイルを正しく識別する', () => {
    const gifBuffer = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
    expect(getFileTypeFromBuffer(gifBuffer)).toBe('image/gif')
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