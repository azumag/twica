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

const usage: StorageUsage = {
  userUsage: 1024,
  globalUsage: 2048,
  userLimitReached: false,
  globalLimitReached: false,
  userLimitBytes: 10 * 1024 * 1024,
  globalLimitBytes: 50 * 1024 * 1024 * 1024,
  planOverLimit: false,
}

describe('GET /api/storage-status usage argument wiring (#1352)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSession.mockResolvedValue({
      twitchUserId: '987654321',
      twitchUsername: 'test-user',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/avatar.jpg',
      broadcasterType: 'affiliate',
      expiresAt: 4_102_444_800_000,
      version: 1,
    })
    mockCanUseStreamerFeatures.mockReturnValue(true)
    mockSha256Prefix.mockResolvedValue('cafebabe')
    mockGetStorageUsage.mockResolvedValue(usage)
    mockFormatBytes.mockImplementation((bytes) => `${bytes} B`)
  })

  it('sessionのTwitch IDからprefixを生成し、prefixと同じTwitch IDをusage取得へ渡す', async () => {
    const response = await GET()

    expect(response.status).toBe(200)
    expect(mockSha256Prefix).toHaveBeenCalledTimes(1)
    expect(mockSha256Prefix).toHaveBeenCalledWith('987654321')
    expect(mockGetStorageUsage).toHaveBeenCalledTimes(1)
    expect(mockGetStorageUsage).toHaveBeenCalledWith('cafebabe', '987654321')
  })
})
