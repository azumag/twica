import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import { POST } from '@/app/api/upload/sound/route'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { checkRateLimit } from '@/lib/rate-limit'
import { validateCSRFToken } from '@/lib/csrf'
import { uploadSoundToR2WithRetry } from '@/lib/r2-client'

// Mock dependencies
// tests/unit/upload.test.ts (画像アップロード) と同じモック構成
vi.mock('next/headers')
vi.mock('@/lib/session')
vi.mock('@/lib/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit')>()
  return {
    ...actual,
    checkRateLimit: vi.fn(),
  }
})
vi.mock('@/lib/csrf')
// R2クライアントをモックしてアップロード機能をテスト
vi.mock('@/lib/r2-client', () => ({
  uploadSoundToR2WithRetry: vi.fn(),
  deleteSoundFromR2: vi.fn(),
}))

const mockCookies = vi.mocked(cookies)
const mockGetSession = vi.mocked(getSession)
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures)
const mockCheckRateLimit = vi.mocked(checkRateLimit)
const mockUploadSoundToR2WithRetry = vi.mocked(uploadSoundToR2WithRetry)
const mockValidateCSRFToken = vi.mocked(validateCSRFToken)

function createMinimalMp3Buffer(): ArrayBuffer {
  // ID3タグ (49 44 33) + 適当な後続バイトでgetSoundFileTypeFromBufferの12バイト最小長を満たす
  const header = new Uint8Array([
    0x49, 0x44, 0x33, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ])
  return header.buffer
}

describe('POST /api/upload/sound', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockValidateCSRFToken.mockResolvedValue({ valid: true })
    mockCanUseStreamerFeatures.mockReturnValue(true)
    mockCookies.mockResolvedValue({
      get: vi.fn().mockReturnValue(undefined),
    } as unknown as Awaited<ReturnType<typeof cookies>>)
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Date.now() + 60000,
    })
    mockGetSession.mockResolvedValue({
      twitchUserId: 'test-user-id',
      twitchUsername: 'test-user',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/avatar.jpg',
      broadcasterType: '',
      expiresAt: Date.now() + 3600000,
      version: 1,
    })
  })

  it('正常な効果音アップロードに成功する', async () => {
    mockUploadSoundToR2WithRetry.mockResolvedValue({
      url: 'https://sound.example.com/sound_test.mp3',
    })

    const soundFile = new File([createMinimalMp3Buffer()], 'test.mp3', {
      type: 'audio/mpeg',
    })
    const formData = new FormData()
    formData.append('file', soundFile)

    const request = new NextRequest('http://localhost:3000/api/upload/sound', {
      method: 'POST',
      body: formData,
    })

    const response = await POST(request)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.url).toBe('https://sound.example.com/sound_test.mp3')
    expect(mockUploadSoundToR2WithRetry).toHaveBeenCalledTimes(1)
  })

  describe('R2一時障害からのリトライ (#976, #977)', () => {
    it('R2内部エラー(10001)は再試行して成功する', async () => {
      // uploadSoundToR2WithRetry自体は1回で確定させ(ネットワークエラー用の内側リトライは
      // 対象外)、r2-retry-policyの外側retryCloudflareR2Uploadが10001を拾って
      // 再試行することを固定する。画像アップロード側の同名テスト(tests/unit/upload.test.ts)
      // と対になるsound route側のリグレッションガード。
      mockUploadSoundToR2WithRetry
        .mockResolvedValueOnce({ error: 'put: We encountered an internal error. Please try again. (10001)' })
        .mockResolvedValueOnce({ url: 'https://sound.example.com/sound_test.mp3' })

      const soundFile = new File([createMinimalMp3Buffer()], 'test.mp3', {
        type: 'audio/mpeg',
      })
      const formData = new FormData()
      formData.append('file', soundFile)

      const request = new NextRequest('http://localhost:3000/api/upload/sound', {
        method: 'POST',
        body: formData,
      })

      // retryCloudflareR2Uploadの初回バックオフ(実時間500ms)を挟んで再試行される。
      // 画像アップロード側の同名テスト(tests/unit/upload.test.ts)と同じ理由で
      // fake timersは使わず実タイマーのまま待つ。
      const response = await POST(request)

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.url).toBe('https://sound.example.com/sound_test.mp3')
      expect(mockUploadSoundToR2WithRetry).toHaveBeenCalledTimes(2)
    })
  })

  describe('R2アップロードエラー時', () => {
    it('非一時エラー(AccessDenied)は再試行せず500を返す', async () => {
      mockUploadSoundToR2WithRetry.mockResolvedValue({ error: 'AccessDenied: invalid credentials' })

      const soundFile = new File([createMinimalMp3Buffer()], 'test.mp3', {
        type: 'audio/mpeg',
      })
      const formData = new FormData()
      formData.append('file', soundFile)

      const request = new NextRequest('http://localhost:3000/api/upload/sound', {
        method: 'POST',
        body: formData,
      })

      const response = await POST(request)

      expect(response.status).toBe(500)
      expect(mockUploadSoundToR2WithRetry).toHaveBeenCalledTimes(1)
    })
  })
})
