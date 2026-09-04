import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GET } from '@/app/api/storage-status/route'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { getStorageUsage, formatBytes, type StorageUsage } from '@/lib/storage-usage'
import { sha256Prefix } from '@/lib/crypto-utils'

vi.mock('@/lib/session')
vi.mock('@/lib/storage-usage', () => ({
  getStorageUsage: vi.fn(),
  formatBytes: vi.fn(),
}))
vi.mock('@/lib/crypto-utils', () => ({
  sha256Prefix: vi.fn(),
}))

const mockGetSession = vi.mocked(getSession)
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures)
const mockGetStorageUsage = vi.mocked(getStorageUsage)
const mockFormatBytes = vi.mocked(formatBytes)
const mockSha256Prefix = vi.mocked(sha256Prefix)

const baseUsage: StorageUsage = {
  userUsage: 1024,
  globalUsage: 2048,
  userLimitReached: false,
  globalLimitReached: false,
  userLimitBytes: 10 * 1024 * 1024,
  globalLimitBytes: 50 * 1024 * 1024 * 1024,
  planOverLimit: false,
}

async function getStorageStatus(overrides: Partial<StorageUsage> = {}) {
  mockGetStorageUsage.mockResolvedValue({ ...baseUsage, ...overrides })
  const response = await GET()
  expect(response.status).toBe(200)
  return response.json() as Promise<{ message: string | null }>
}

describe('GET /api/storage-status message compatibility', () => {
  // 互換契約の退行を検知するため、production の定数を参照せず期待文字列をリテラルで固定する。
  // 定数側の文言変更へテストも同時追従すると、未知クライアント向け message の意図しない変更を検知できない。
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSession.mockResolvedValue({
      twitchUserId: 'test-user-id',
      twitchUsername: 'test-user',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/avatar.jpg',
      broadcasterType: 'affiliate',
      expiresAt: Date.now() + 3600000,
      version: 1,
    })
    mockCanUseStreamerFeatures.mockReturnValue(true)
    mockSha256Prefix.mockResolvedValue('12345678')
    mockFormatBytes.mockImplementation((bytes) => `${bytes} B`)
  })

  it('planOverLimit を最優先の互換 message として返す', async () => {
    const body = await getStorageStatus({
      planOverLimit: true,
      globalLimitReached: true,
      userLimitReached: true,
    })

    expect(body.message).toBe(
      'ストレージ容量を超過しています。支援特典をアップグレードするか、画像を削除してください。'
    )
  })

  it('globalLimitReached を userLimitReached より優先する', async () => {
    const body = await getStorageStatus({
      globalLimitReached: true,
      userLimitReached: true,
    })

    expect(body.message).toBe('画像のアップロード上限に達しました。')
  })

  it('userLimitReached の互換 message を返す', async () => {
    const body = await getStorageStatus({ userLimitReached: true })

    expect(body.message).toBe(
      '画像のアップロード上限は現在一アカウントにつき10MBです。上限を超える場合は、既存の画像を削除してから再度お試しください。'
    )
  })

  it('制限に達していなければ message は null を返す', async () => {
    const body = await getStorageStatus()

    expect(body.message).toBeNull()
  })
})
