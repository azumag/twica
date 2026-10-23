import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import { POST, DELETE } from '@/app/api/upload/sound/route'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { checkRateLimit } from '@/lib/rate-limit'
import { validateCSRFToken } from '@/lib/csrf'
import { uploadSoundToR2WithRetry, deleteSoundFromR2 } from '@/lib/r2-client'
import { recordBlobFile, releaseStorageReservation, removeBlobFile } from '@/lib/storage-db'
import { reserveStorageCapacity } from '@/lib/storage-usage'
import { sha256Prefix } from '@/lib/crypto-utils'

// Mock dependencies
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
// R2クライアントをモックして音声アップロード・削除をテスト
vi.mock('@/lib/r2-client', () => ({
  uploadSoundToR2WithRetry: vi.fn(),
  deleteSoundFromR2: vi.fn(),
}))
// ストレージ台帳をモック（#1896: 音声も台帳記録・削除減算の対象）
vi.mock('@/lib/storage-db', () => ({
  recordBlobFile: vi.fn().mockResolvedValue('committed'),
  releaseStorageReservation: vi.fn().mockResolvedValue(true),
  removeBlobFile: vi.fn().mockResolvedValue(null),
}))
// Mock storage-usage to provide the atomic reservation result (#1907)
vi.mock('@/lib/storage-usage', () => ({
  reserveStorageCapacity: vi.fn().mockResolvedValue({
    ok: true,
    reservationId: 'reservation-1',
    degraded: false,
  }),
}))

const mockCookies = vi.mocked(cookies)
const mockGetSession = vi.mocked(getSession)
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures)
const mockCheckRateLimit = vi.mocked(checkRateLimit)
const mockValidateCSRFToken = vi.mocked(validateCSRFToken)
const mockUploadSound = vi.mocked(uploadSoundToR2WithRetry)
const mockDeleteSound = vi.mocked(deleteSoundFromR2)
const mockRecordBlobFile = vi.mocked(recordBlobFile)
const mockReleaseStorageReservation = vi.mocked(releaseStorageReservation)
const mockRemoveBlobFile = vi.mocked(removeBlobFile)
const mockReserveStorageCapacity = vi.mocked(reserveStorageCapacity)

function createMinimalWavBuffer(): ArrayBuffer {
  // getSoundFileTypeFromBuffer は buffer[0..3] == "RIFF" と buffer[8..11] == "WAVE"
  // を見るため12バイト以上の実WAVに近いヘッダを用意する
  const header = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, // "RIFF"
    0x24, 0x00, 0x00, 0x00, // riff chunk size
    0x57, 0x41, 0x56, 0x45, // "WAVE"
    0x66, 0x6D, 0x74, 0x20, // "fmt "
    0x10, 0x00, 0x00, 0x00, // fmt chunk size (16)
    0x01, 0x00,             // audio format (PCM)
    0x01, 0x00,             // channels (mono)
    0x44, 0xAC, 0x00, 0x00, // sample rate (44100)
    0x88, 0x58, 0x01, 0x00, // byte rate
    0x02, 0x00,             // block align
    0x10, 0x00,             // bits per sample
    0x64, 0x61, 0x74, 0x61, // "data"
    0x00, 0x00, 0x00, 0x00, // data size
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
    mockReserveStorageCapacity.mockResolvedValue({
      ok: true,
      reservationId: 'reservation-1',
    degraded: false,
    })
    mockReleaseStorageReservation.mockResolvedValue(true)
    mockRemoveBlobFile.mockResolvedValue(null)
    // clearAllMocks は実装を消さないため、前テストの mockRejectedValue 漏洩を防ぐ
    mockUploadSound.mockResolvedValue({ url: 'https://r2.example.com/sound.wav' })
    mockRecordBlobFile.mockResolvedValue('committed')
    mockDeleteSound.mockResolvedValue(undefined)
  })

  const makeUploadRequest = () => {
    const formData = new FormData()
    formData.append(
      'file',
      new File([createMinimalWavBuffer()], 'test.wav', { type: 'audio/wav' })
    )
    return new NextRequest('http://localhost:3000/api/upload/sound', {
      method: 'POST',
      body: formData,
    })
  }

  it('200を返しR2保存後に台帳へ記録する（url / ユーザー / サイズ / r2）', async () => {
    mockUploadSound.mockResolvedValue({ url: 'https://r2.example.com/sound.wav' })

    const response = await POST(makeUploadRequest())

    expect(response.status).toBe(200)
    expect(mockUploadSound).toHaveBeenCalled()
    // ファイル名は sound_{userPrefix(8hex)}_{UUID}.wav 形式（#832）
    expect(mockUploadSound.mock.calls[0][0]).toMatch(
      /^sound_[a-f0-9]{8}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.wav$/
    )
    // #1896 / #1907: 音声も予約ID付きで使用量台帳に記録される
    expect(mockRecordBlobFile).toHaveBeenCalledWith(
      'reservation-1',
      'https://r2.example.com/sound.wav',
      expect.any(String),
      expect.any(Number),
      'r2'
    )
    expect(mockReleaseStorageReservation).not.toHaveBeenCalled()
  })

  it('全体上限: 予約が global_limit を返したら507を返しR2に保存しない', async () => {
    mockReserveStorageCapacity.mockResolvedValue({ ok: false, reason: 'global_limit' })

    const response = await POST(makeUploadRequest())

    expect(response.status).toBe(507)
    const body = await response.json()
    expect(body.code).toBe('GLOBAL_LIMIT_REACHED')
    expect(mockUploadSound).not.toHaveBeenCalled()
    expect(mockRecordBlobFile).not.toHaveBeenCalled()
  })

  it('ユーザー上限: 予約が user_limit を返したら507を返す（追加バイト数込みの原子的判定）', async () => {
    mockReserveStorageCapacity.mockResolvedValue({ ok: false, reason: 'user_limit' })

    const response = await POST(makeUploadRequest())

    expect(response.status).toBe(507)
    const body = await response.json()
    expect(body.code).toBe('USER_LIMIT_REACHED')
    expect(mockUploadSound).not.toHaveBeenCalled()
  })

  it('容量が取得不能な場合（fail-closed）も予約失敗として507で拒否する', async () => {
    mockReserveStorageCapacity.mockResolvedValue({ ok: false, reason: 'global_limit' })

    const response = await POST(makeUploadRequest())

    expect(response.status).toBe(507)
    expect(mockUploadSound).not.toHaveBeenCalled()
  })

  it('音声507は画像向け文言ではなく効果音向け文言を返す (#1907)', async () => {
    mockReserveStorageCapacity.mockResolvedValue({ ok: false, reason: 'user_limit' })

    const response = await POST(makeUploadRequest())
    const body = await response.json()

    expect(response.status).toBe(507)
    expect(body.error).toContain('効果音')
    expect(body.error).not.toContain('画像')
  })

  it('保存の直前に、ユーザー・追加バイト数を渡して原子的に予約する', async () => {
    const response = await POST(makeUploadRequest())

    expect(response.status).toBe(200)
    expect(mockReserveStorageCapacity).toHaveBeenCalledWith(
      expect.stringMatching(/^[a-f0-9]{8}$/),
      'test-user-id',
      expect.any(Number),
    )
  })

  it('台帳記録失敗時は500を返し、R2オブジェクトと予約を補償する', async () => {
    mockUploadSound.mockResolvedValue({ url: 'https://r2.example.com/sound.wav' })
    mockRecordBlobFile.mockRejectedValue(new Error('db down'))

    const response = await POST(makeUploadRequest())

    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body.code).toBe('STORAGE_LEDGER_FAILED')
    // 補償: 台帳未記録のオブジェクトがR2に残らないよう、保存直後のファイル名で削除
    expect(mockDeleteSound).toHaveBeenCalledTimes(1)
    expect(mockDeleteSound).toHaveBeenCalledWith(mockUploadSound.mock.calls[0][0])
    expect(mockReleaseStorageReservation).toHaveBeenCalledWith('reservation-1')
  })

  it('台帳記録失敗時にR2削除（補償）も失敗した場合も500を返し、予約は解放する', async () => {
    mockUploadSound.mockResolvedValue({ url: 'https://r2.example.com/sound.wav' })
    mockRecordBlobFile.mockRejectedValue(new Error('db down'))
    mockDeleteSound.mockRejectedValue(new Error('r2 down'))

    const response = await POST(makeUploadRequest())

    expect(response.status).toBe(500)
    expect(mockDeleteSound).toHaveBeenCalledTimes(1)
    expect(mockReleaseStorageReservation).toHaveBeenCalledWith('reservation-1')
  })

  it('予約RPC未適用（degraded）でも旧経路でアップロードを継続する', async () => {
    mockReserveStorageCapacity.mockResolvedValue({
      ok: true,
      reservationId: null,
      degraded: true,
    })

    const response = await POST(makeUploadRequest())

    expect(response.status).toBe(200)
    expect(mockRecordBlobFile).toHaveBeenCalledWith(
      null,
      'https://r2.example.com/sound.wav',
      expect.any(String),
      expect.any(Number),
      'r2',
    )
    expect(mockReleaseStorageReservation).not.toHaveBeenCalled()
  })

  it('台帳が確定済み（already_committed）ならR2も予約も解放しない', async () => {
    mockRecordBlobFile.mockResolvedValue('already_committed')

    const response = await POST(makeUploadRequest())

    expect(response.status).toBe(200)
    expect(mockDeleteSound).not.toHaveBeenCalled()
    expect(mockReleaseStorageReservation).not.toHaveBeenCalled()
  })

  it('R2アップロード失敗時（storage error）は台帳に記録せず503を返し、予約を解放する', async () => {
    // 'service unavailable' は handleBlobError で 503 に分類される
    mockUploadSound.mockRejectedValue(new Error('service unavailable'))

    const response = await POST(makeUploadRequest())

    expect(response.status).toBe(503)
    expect(mockRecordBlobFile).not.toHaveBeenCalled()
    expect(mockReleaseStorageReservation).toHaveBeenCalledWith('reservation-1')
  })

  it('R2アップロードがエラー結果を返した場合も台帳に記録せず、予約を解放する', async () => {
    // { error } を返す経路（リトライ後も失敗）: 'quota' は 507 に分類される
    mockUploadSound.mockResolvedValue({ error: 'R2 quota exceeded' })

    const response = await POST(makeUploadRequest())

    expect(response.status).toBe(507)
    expect(mockRecordBlobFile).not.toHaveBeenCalled()
    expect(mockReleaseStorageReservation).toHaveBeenCalledWith('reservation-1')
  })
})

describe('DELETE /api/upload/sound', () => {
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
    mockRemoveBlobFile.mockResolvedValue(null)
    // POST describe で設定された reject 実装の漏洩を防ぐ
    mockDeleteSound.mockResolvedValue(undefined)
    mockRecordBlobFile.mockResolvedValue('committed')
  })

  const makeDeleteRequest = async () => {
    // DELETE は自分のプレフィックス（sha256Prefix(twitchUserId)）で始まる
    // ファイル名のみ削除を許可するため、実値から URL を組み立てる
    const prefix = await sha256Prefix('test-user-id')
    const url = `https://r2.example.com/sound_${prefix}_11111111-2222-3333-4444-555555555555.wav`
    return {
      request: new NextRequest('http://localhost:3000/api/upload/sound', {
        method: 'DELETE',
        body: JSON.stringify({ url }),
        headers: { 'content-type': 'application/json' },
      }),
      url,
    }
  }

  it('R2削除成功後に台帳から減算する', async () => {
    const { request, url } = await makeDeleteRequest()

    const response = await DELETE(request)

    expect(response.status).toBe(200)
    expect(mockDeleteSound).toHaveBeenCalledTimes(1)
    // #1896: 音声削除は使用量台帳からも減算される
    expect(mockRemoveBlobFile).toHaveBeenCalledWith(url)
  })

  it('台帳減算が失敗してもR2削除は成功扱いで200を返す（過大計上は安全側・ログで追跡）', async () => {
    const { request } = await makeDeleteRequest()
    mockRemoveBlobFile.mockRejectedValue(new Error('db down'))

    const response = await DELETE(request)

    expect(response.status).toBe(200)
    expect(mockDeleteSound).toHaveBeenCalledTimes(1)
    expect(mockRemoveBlobFile).toHaveBeenCalledTimes(1)
  })

  it('台帳未記録の旧オブジェクト（removeBlobFile が null）も200で削除できる', async () => {
    const { request } = await makeDeleteRequest()
    mockRemoveBlobFile.mockResolvedValue(null)

    const response = await DELETE(request)

    expect(response.status).toBe(200)
    expect(mockRemoveBlobFile).toHaveBeenCalledTimes(1)
  })

  it('他人のプレフィックスで始まるファイル名は403で拒否する', async () => {
    const request = new NextRequest('http://localhost:3000/api/upload/sound', {
      method: 'DELETE',
      body: JSON.stringify({
        url: 'https://r2.example.com/sound_deadbeef_11111111-2222-3333-4444-555555555555.wav',
      }),
      headers: { 'content-type': 'application/json' },
    })

    const response = await DELETE(request)

    expect(response.status).toBe(403)
    expect(mockDeleteSound).not.toHaveBeenCalled()
    expect(mockRemoveBlobFile).not.toHaveBeenCalled()
  })
})
