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

type StorageStatusBody = Pick<
  StorageUsage,
  'userLimitReached' | 'globalLimitReached' | 'planOverLimit'
> & {
  uploadDisabled: boolean
}

async function getStorageStatus(
  overrides: Partial<StorageUsage> = {}
): Promise<StorageStatusBody> {
  mockGetStorageUsage.mockResolvedValue({ ...baseUsage, ...overrides })
  const response = await GET()
  expect(response.status).toBe(200)
  return response.json() as Promise<StorageStatusBody>
}

/**
 * Issue #1352 の machine-readable 契約を route 境界で固定する。
 * getStorageUsage の各制限フラグはここでは既に導出済みの入力として扱い、
 * 上流の現在の相関に依存せず各 OR 項を独立に検証する。
 */
describe('GET /api/storage-status uploadDisabled contract (#1352)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSession.mockResolvedValue({
      twitchUserId: 'test-user-id',
      twitchUsername: 'test-user',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/avatar.jpg',
      broadcasterType: 'affiliate',
      expiresAt: 4_102_444_800_000,
      version: 1,
    })
    mockCanUseStreamerFeatures.mockReturnValue(true)
    mockSha256Prefix.mockResolvedValue('12345678')
    mockFormatBytes.mockImplementation((bytes) => `${bytes} B`)
  })

  it('制限フラグがすべて false なら uploadDisabled は false', async () => {
    const body = await getStorageStatus()

    expect(body).toMatchObject({
      userLimitReached: false,
      globalLimitReached: false,
      planOverLimit: false,
      uploadDisabled: false,
    })
  })

  it('userLimitReached が true なら uploadDisabled は true', async () => {
    const body = await getStorageStatus({ userLimitReached: true })

    expect(body).toMatchObject({
      userLimitReached: true,
      globalLimitReached: false,
      planOverLimit: false,
      uploadDisabled: true,
    })
  })

  it('globalLimitReached が true なら uploadDisabled は true', async () => {
    const body = await getStorageStatus({ globalLimitReached: true })

    expect(body).toMatchObject({
      userLimitReached: false,
      globalLimitReached: true,
      planOverLimit: false,
      uploadDisabled: true,
    })
  })

  it('planOverLimit が true なら uploadDisabled は true', async () => {
    const body = await getStorageStatus({ planOverLimit: true })

    expect(body).toMatchObject({
      userLimitReached: false,
      globalLimitReached: false,
      planOverLimit: true,
      uploadDisabled: true,
    })
  })
})
