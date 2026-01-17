import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/upload/route'
import { getSession } from '@/lib/session'
import { checkRateLimit } from '@/lib/rate-limit'
import { put } from '@vercel/blob'

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
      expect(body.error).toBe('リクエストが多すぎます。しばらく待ってから再試行してください。')
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
      expect(body.error).toBe('ファイルが選択されていません')
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
      expect(body.error).toBe('ファイルサイズは1.0MB以下にしてください')
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
      expect(body.error).toBe('画像ファイル（JPEG, PNG）のみ対応しています')
    })
  })

  describe('正常な画像アップロード', () => {
    it('200 ステータスと URL を返す', async () => {
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