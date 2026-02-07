import { describe, it, expect, beforeEach, vi } from 'vitest'
import { UPLOAD_CONFIG } from '@/lib/constants'

vi.mock('@/lib/logger')
vi.mock('@/lib/storage-db', () => ({
  getStorageUsageFromDB: vi.fn(),
  getStorageBonusBytes: vi.fn(),
}))

describe('getStorageUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('should return base limit when no twitchUserId provided', async () => {
    const { getStorageUsageFromDB, getStorageBonusBytes } = await import('@/lib/storage-db')
    vi.mocked(getStorageUsageFromDB).mockResolvedValue({
      userUsage: 1000,
      globalUsage: 5000,
      userLimitReached: false,
      globalLimitReached: false,
      userLimitBytes: UPLOAD_CONFIG.USER_STORAGE_LIMIT,
      globalLimitBytes: UPLOAD_CONFIG.GLOBAL_STORAGE_LIMIT,
    })
    vi.mocked(getStorageBonusBytes).mockResolvedValue(0)

    const { getStorageUsage } = await import('@/lib/storage-usage')
    const result = await getStorageUsage('testprefix')

    expect(result.userLimitBytes).toBe(UPLOAD_CONFIG.USER_STORAGE_LIMIT)
    expect(result.userLimitReached).toBe(false)
    // getStorageBonusBytesはtwitchUserIdなしでは呼ばれない
    expect(getStorageBonusBytes).not.toHaveBeenCalled()
  })

  it('should add bonus bytes to effective limit when twitchUserId provided', async () => {
    const bonusBytes = 5 * 1024 * 1024 // 5MB
    const { getStorageUsageFromDB, getStorageBonusBytes } = await import('@/lib/storage-db')
    vi.mocked(getStorageUsageFromDB).mockResolvedValue({
      userUsage: UPLOAD_CONFIG.USER_STORAGE_LIMIT - 1, // ベース制限のギリギリ下
      globalUsage: 0,
      userLimitReached: true, // DB側の判定ではベース制限超え
      globalLimitReached: false,
      userLimitBytes: UPLOAD_CONFIG.USER_STORAGE_LIMIT,
      globalLimitBytes: UPLOAD_CONFIG.GLOBAL_STORAGE_LIMIT,
    })
    vi.mocked(getStorageBonusBytes).mockResolvedValue(bonusBytes)

    const { getStorageUsage } = await import('@/lib/storage-usage')
    const result = await getStorageUsage('testprefix', 'twitch-user-123')

    // ボーナス込みの制限に対してはまだ制限以下
    expect(result.userLimitBytes).toBe(UPLOAD_CONFIG.USER_STORAGE_LIMIT + bonusBytes)
    expect(result.userLimitReached).toBe(false)
  })

  it('should mark userLimitReached when usage exceeds bonus-adjusted limit', async () => {
    const bonusBytes = 5 * 1024 * 1024 // 5MB
    const totalLimit = UPLOAD_CONFIG.USER_STORAGE_LIMIT + bonusBytes
    const { getStorageUsageFromDB, getStorageBonusBytes } = await import('@/lib/storage-db')
    vi.mocked(getStorageUsageFromDB).mockResolvedValue({
      userUsage: totalLimit, // ボーナス込み制限に到達
      globalUsage: 0,
      userLimitReached: true,
      globalLimitReached: false,
      userLimitBytes: UPLOAD_CONFIG.USER_STORAGE_LIMIT,
      globalLimitBytes: UPLOAD_CONFIG.GLOBAL_STORAGE_LIMIT,
    })
    vi.mocked(getStorageBonusBytes).mockResolvedValue(bonusBytes)

    const { getStorageUsage } = await import('@/lib/storage-usage')
    const result = await getStorageUsage('testprefix', 'twitch-user-123')

    expect(result.userLimitReached).toBe(true)
  })

  it('should return safe defaults when getStorageUsageFromDB throws', async () => {
    const { getStorageUsageFromDB, getStorageBonusBytes } = await import('@/lib/storage-db')
    vi.mocked(getStorageUsageFromDB).mockRejectedValue(new Error('DB error'))
    vi.mocked(getStorageBonusBytes).mockResolvedValue(0)

    const { getStorageUsage } = await import('@/lib/storage-usage')
    const result = await getStorageUsage('testprefix', 'twitch-user-123')

    // エラー時はアップロードをブロックしない
    expect(result.userLimitReached).toBe(false)
    expect(result.globalLimitReached).toBe(false)
    expect(result.userUsage).toBe(0)
  })

  it('should handle getStorageBonusBytes error gracefully via Promise.all', async () => {
    const { getStorageUsageFromDB, getStorageBonusBytes } = await import('@/lib/storage-db')
    vi.mocked(getStorageUsageFromDB).mockResolvedValue({
      userUsage: 1000,
      globalUsage: 0,
      userLimitReached: false,
      globalLimitReached: false,
      userLimitBytes: UPLOAD_CONFIG.USER_STORAGE_LIMIT,
      globalLimitBytes: UPLOAD_CONFIG.GLOBAL_STORAGE_LIMIT,
    })
    // getStorageBonusBytesがエラーを投げるとPromise.all全体が失敗する
    vi.mocked(getStorageBonusBytes).mockRejectedValue(new Error('bonus error'))

    const { getStorageUsage } = await import('@/lib/storage-usage')
    const result = await getStorageUsage('testprefix', 'twitch-user-123')

    // Promise.allの失敗はcatchで捕捉され、安全なデフォルトを返す
    expect(result.userLimitReached).toBe(false)
    expect(result.globalLimitReached).toBe(false)
  })
})
