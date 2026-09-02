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
  userUsage: 111,
  globalUsage: 222,
  userLimitReached: false,
  globalLimitReached: false,
  userLimitBytes: 333,
  globalLimitBytes: 444,
  planOverLimit: false,
}

describe('GET /api/storage-status formatBytes wiring (#1363)', () => {
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
    mockFormatBytes.mockImplementation((bytes) => `formatted:${bytes}`)
  })

  it('usageとlimitの4値を対応するformattedフィールドへ配線する', async () => {
    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mockFormatBytes.mock.calls).toEqual([
      [111],
      [222],
      [333],
      [444],
    ])
    expect(body).toMatchObject({
      userUsageFormatted: 'formatted:111',
      globalUsageFormatted: 'formatted:222',
      userLimitFormatted: 'formatted:333',
      globalLimitFormatted: 'formatted:444',
    })
  })
})
