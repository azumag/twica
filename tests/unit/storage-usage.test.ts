import { describe, it, expect, beforeEach, vi } from 'vitest'
import { UPLOAD_CONFIG } from '@/lib/constants'

vi.mock('@/lib/logger')
vi.mock('@/lib/storage-db', () => ({
  getStorageUsageFromDB: vi.fn(),
  getStorageBonusBytes: vi.fn(),
  reserveStorageUsage: vi.fn(),
}))
vi.mock('@/lib/plan', () => ({
  getPlanStorageBytes: vi.fn(),
}))

describe('getStorageUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('should return base limit when no twitchUserId provided', async () => {
    const { getStorageUsageFromDB, getStorageBonusBytes } = await import('@/lib/storage-db')
    const { getPlanStorageBytes } = await import('@/lib/plan')
    vi.mocked(getStorageUsageFromDB).mockResolvedValue({
      userUsage: 1000,
      globalUsage: 5000,
      userLimitReached: false,
      globalLimitReached: false,
      userLimitBytes: UPLOAD_CONFIG.USER_STORAGE_LIMIT,
      globalLimitBytes: UPLOAD_CONFIG.GLOBAL_STORAGE_LIMIT,
    })
    vi.mocked(getStorageBonusBytes).mockResolvedValue(0)
    vi.mocked(getPlanStorageBytes).mockResolvedValue(0)

    const { getStorageUsage } = await import('@/lib/storage-usage')
    const result = await getStorageUsage('testprefix')

    expect(result.userLimitBytes).toBe(UPLOAD_CONFIG.USER_STORAGE_LIMIT)
    expect(result.userLimitReached).toBe(false)
    // getStorageBonusBytesはtwitchUserIdなしでは呼ばれない
    expect(getStorageBonusBytes).not.toHaveBeenCalled()
    expect(getPlanStorageBytes).not.toHaveBeenCalled()
  })

  it('should add bonus bytes to effective limit when twitchUserId provided', async () => {
    const bonusBytes = 5 * 1024 * 1024 // 5MB
    const { getStorageUsageFromDB, getStorageBonusBytes } = await import('@/lib/storage-db')
    const { getPlanStorageBytes } = await import('@/lib/plan')
    vi.mocked(getStorageUsageFromDB).mockResolvedValue({
      userUsage: UPLOAD_CONFIG.USER_STORAGE_LIMIT - 1, // ベース制限のギリギリ下
      globalUsage: 0,
      userLimitReached: true, // DB側の判定ではベース制限超え
      globalLimitReached: false,
      userLimitBytes: UPLOAD_CONFIG.USER_STORAGE_LIMIT,
      globalLimitBytes: UPLOAD_CONFIG.GLOBAL_STORAGE_LIMIT,
    })
    vi.mocked(getStorageBonusBytes).mockResolvedValue(bonusBytes)
    vi.mocked(getPlanStorageBytes).mockResolvedValue(0)

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
    const { getPlanStorageBytes } = await import('@/lib/plan')
    vi.mocked(getStorageUsageFromDB).mockResolvedValue({
      userUsage: totalLimit, // ボーナス込み制限に到達
      globalUsage: 0,
      userLimitReached: true,
      globalLimitReached: false,
      userLimitBytes: UPLOAD_CONFIG.USER_STORAGE_LIMIT,
      globalLimitBytes: UPLOAD_CONFIG.GLOBAL_STORAGE_LIMIT,
    })
    vi.mocked(getStorageBonusBytes).mockResolvedValue(bonusBytes)
    vi.mocked(getPlanStorageBytes).mockResolvedValue(0)

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

    // エラー時は容量が確認できないのでアップロードをブロックする (#1896)
    expect(result.userLimitReached).toBe(true)
    expect(result.globalLimitReached).toBe(true)
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

    // Promise.allの失敗はcatchで捕捉され、容量確認不能としてブロックする (#1896)
    expect(result.userLimitReached).toBe(true)
    expect(result.globalLimitReached).toBe(true)
  })

  it('should add planBytes to effective limit for supporter plan', async () => {
    const planBytes = 500 * 1024 * 1024 // 500MB (support plan)
    const { getStorageUsageFromDB, getStorageBonusBytes } = await import('@/lib/storage-db')
    const { getPlanStorageBytes } = await import('@/lib/plan')
    vi.mocked(getStorageUsageFromDB).mockResolvedValue({
      userUsage: UPLOAD_CONFIG.USER_STORAGE_LIMIT + 1, // ベース制限を超過
      globalUsage: 0,
      userLimitReached: true,
      globalLimitReached: false,
      userLimitBytes: UPLOAD_CONFIG.USER_STORAGE_LIMIT,
      globalLimitBytes: UPLOAD_CONFIG.GLOBAL_STORAGE_LIMIT,
    })
    vi.mocked(getStorageBonusBytes).mockResolvedValue(0)
    vi.mocked(getPlanStorageBytes).mockResolvedValue(planBytes)

    const { getStorageUsage } = await import('@/lib/storage-usage')
    const result = await getStorageUsage('testprefix', 'twitch-user-123')

    // プランボーナス込みではまだ制限以下
    expect(result.userLimitBytes).toBe(UPLOAD_CONFIG.USER_STORAGE_LIMIT + planBytes)
    expect(result.userLimitReached).toBe(false)
    expect(result.planOverLimit).toBe(false)
  })

  it('should combine bonus and planBytes in effective limit', async () => {
    const bonusBytes = 5 * 1024 * 1024 // 5MB (campaign bonus)
    const planBytes = 500 * 1024 * 1024 // 500MB (support plan)
    const totalLimit = UPLOAD_CONFIG.USER_STORAGE_LIMIT + bonusBytes + planBytes
    const { getStorageUsageFromDB, getStorageBonusBytes } = await import('@/lib/storage-db')
    const { getPlanStorageBytes } = await import('@/lib/plan')
    vi.mocked(getStorageUsageFromDB).mockResolvedValue({
      userUsage: totalLimit - 1, // 全ボーナス合計の制限ギリギリ下
      globalUsage: 0,
      userLimitReached: true,
      globalLimitReached: false,
      userLimitBytes: UPLOAD_CONFIG.USER_STORAGE_LIMIT,
      globalLimitBytes: UPLOAD_CONFIG.GLOBAL_STORAGE_LIMIT,
    })
    vi.mocked(getStorageBonusBytes).mockResolvedValue(bonusBytes)
    vi.mocked(getPlanStorageBytes).mockResolvedValue(planBytes)

    const { getStorageUsage } = await import('@/lib/storage-usage')
    const result = await getStorageUsage('testprefix', 'twitch-user-123')

    expect(result.userLimitBytes).toBe(totalLimit)
    expect(result.userLimitReached).toBe(false)
  })

  it('should set planOverLimit true when usage exceeds effective limit after downgrade', async () => {
    // プランダウングレードシナリオ: 以前patronで大量にアップロード後、basicに戻った場合
    const { getStorageUsageFromDB, getStorageBonusBytes } = await import('@/lib/storage-db')
    const { getPlanStorageBytes } = await import('@/lib/plan')
    vi.mocked(getStorageUsageFromDB).mockResolvedValue({
      userUsage: UPLOAD_CONFIG.USER_STORAGE_LIMIT + 100 * 1024 * 1024, // ベース+100MB使用
      globalUsage: 0,
      userLimitReached: true,
      globalLimitReached: false,
      userLimitBytes: UPLOAD_CONFIG.USER_STORAGE_LIMIT,
      globalLimitBytes: UPLOAD_CONFIG.GLOBAL_STORAGE_LIMIT,
    })
    vi.mocked(getStorageBonusBytes).mockResolvedValue(0)
    vi.mocked(getPlanStorageBytes).mockResolvedValue(0) // basicプラン = 0

    const { getStorageUsage } = await import('@/lib/storage-usage')
    const result = await getStorageUsage('testprefix', 'twitch-user-123')

    expect(result.userLimitReached).toBe(true)
    // usage > effectiveLimit なので planOverLimit = true
    expect(result.planOverLimit).toBe(true)
  })

  it('should set planOverLimit false when usage exactly equals effective limit (boundary)', async () => {
    // usage === effectiveLimit: userLimitReached=true（>=判定）, planOverLimit=false（>判定）
    const { getStorageUsageFromDB, getStorageBonusBytes } = await import('@/lib/storage-db')
    const { getPlanStorageBytes } = await import('@/lib/plan')
    vi.mocked(getStorageUsageFromDB).mockResolvedValue({
      userUsage: UPLOAD_CONFIG.USER_STORAGE_LIMIT, // ちょうど制限に到達
      globalUsage: 0,
      userLimitReached: true,
      globalLimitReached: false,
      userLimitBytes: UPLOAD_CONFIG.USER_STORAGE_LIMIT,
      globalLimitBytes: UPLOAD_CONFIG.GLOBAL_STORAGE_LIMIT,
    })
    vi.mocked(getStorageBonusBytes).mockResolvedValue(0)
    vi.mocked(getPlanStorageBytes).mockResolvedValue(0)

    const { getStorageUsage } = await import('@/lib/storage-usage')
    const result = await getStorageUsage('testprefix', 'twitch-user-123')

    expect(result.userLimitReached).toBe(true)
    // ちょうど制限値 = 超過ではないので planOverLimit は false
    expect(result.planOverLimit).toBe(false)
  })

  it('should return planOverLimit false when error occurs', async () => {
    const { getStorageUsageFromDB, getStorageBonusBytes } = await import('@/lib/storage-db')
    const { getPlanStorageBytes } = await import('@/lib/plan')
    vi.mocked(getStorageUsageFromDB).mockRejectedValue(new Error('DB error'))
    vi.mocked(getStorageBonusBytes).mockResolvedValue(0)
    vi.mocked(getPlanStorageBytes).mockResolvedValue(0)

    const { getStorageUsage } = await import('@/lib/storage-usage')
    const result = await getStorageUsage('testprefix', 'twitch-user-123')

    expect(result.planOverLimit).toBe(false)
  })
})

describe('reserveStorageCapacity (#1907)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  async function prime(usage: {
    userUsage: number
    globalUsage: number
    userLimitReached?: boolean
    globalLimitReached?: boolean
  }) {
    const { getStorageUsageFromDB, getStorageBonusBytes, reserveStorageUsage } = await import('@/lib/storage-db')
    const { getPlanStorageBytes } = await import('@/lib/plan')
    vi.mocked(getStorageUsageFromDB).mockResolvedValue({
      userUsage: usage.userUsage,
      globalUsage: usage.globalUsage,
      userLimitReached: usage.userLimitReached ?? false,
      globalLimitReached: usage.globalLimitReached ?? false,
      userLimitBytes: UPLOAD_CONFIG.USER_STORAGE_LIMIT,
      globalLimitBytes: UPLOAD_CONFIG.GLOBAL_STORAGE_LIMIT,
    })
    vi.mocked(getStorageBonusBytes).mockResolvedValue(0)
    vi.mocked(getPlanStorageBytes).mockResolvedValue(0)
    return { reserveStorageUsage }
  }

  it('実効上限を渡して予約し、予約IDを返す', async () => {
    const { reserveStorageUsage } = await prime({ userUsage: 100, globalUsage: 200 })
    vi.mocked(reserveStorageUsage).mockResolvedValue({
      reservationId: 'reservation-1',
      outcome: 'reserved',
      degraded: false,
    })

    const { reserveStorageCapacity } = await import('@/lib/storage-usage')
    await expect(reserveStorageCapacity('prefix12', 'twitch-user-123', 1234)).resolves.toEqual({
      ok: true,
      reservationId: 'reservation-1',
      degraded: false,
    })
    expect(reserveStorageUsage).toHaveBeenCalledWith(
      'prefix12',
      1234,
      UPLOAD_CONFIG.USER_STORAGE_LIMIT,
      UPLOAD_CONFIG.GLOBAL_STORAGE_LIMIT,
    )
  })

  it.each([
    { outcome: 'user_limit' as const, expected: 'user_limit' },
    { outcome: 'global_limit' as const, expected: 'global_limit' },
  ])('予約が $outcome を返したら reason=$expected で失敗する', async ({ outcome, expected }) => {
    const { reserveStorageUsage } = await prime({ userUsage: 100, globalUsage: 200 })
    vi.mocked(reserveStorageUsage).mockResolvedValue({ reservationId: null, outcome, degraded: false })

    const { reserveStorageCapacity } = await import('@/lib/storage-usage')
    await expect(reserveStorageCapacity('prefix12', 'twitch-user-123', 1234)).resolves.toEqual({
      ok: false,
      reason: expected,
    })
  })

  it('使用量取得が失敗した場合（fail-closed flags=true）は予約 RPC を呼ばず拒否する', async () => {
    const { reserveStorageUsage } = await prime({
      userUsage: 0,
      globalUsage: 0,
      userLimitReached: true,
      globalLimitReached: true,
    })

    const { reserveStorageCapacity } = await import('@/lib/storage-usage')
    await expect(reserveStorageCapacity('prefix12', 'twitch-user-123', 1234)).resolves.toEqual({
      ok: false,
      reason: 'global_limit',
    })
    expect(reserveStorageUsage).not.toHaveBeenCalled()
  })

  it('reserved なのに予約IDが無い場合は契約違反として throw する', async () => {
    const { reserveStorageUsage } = await prime({ userUsage: 0, globalUsage: 0 })
    vi.mocked(reserveStorageUsage).mockResolvedValue({
      reservationId: null,
      outcome: 'reserved',
      degraded: false,
    })

    const { reserveStorageCapacity } = await import('@/lib/storage-usage')
    await expect(reserveStorageCapacity('prefix12', 'twitch-user-123', 1234)).rejects.toThrow(
      /reservation ID/,
    )
  })

  it('degraded でも現在使用量+追加バイト数が上限を超える場合は拒否する', async () => {
    const { reserveStorageUsage } = await prime({
      userUsage: UPLOAD_CONFIG.USER_STORAGE_LIMIT - 10,
      globalUsage: 0,
    })
    vi.mocked(reserveStorageUsage).mockResolvedValue({
      reservationId: null,
      outcome: 'reserved',
      degraded: true,
    })

    const { reserveStorageCapacity } = await import('@/lib/storage-usage')
    await expect(reserveStorageCapacity('prefix12', 'twitch-user-123', 100)).resolves.toEqual({
      ok: false,
      reason: 'user_limit',
    })
  })

  it('予約 RPC 未適用（degraded）は旧経路向けに reservationId=null で成功させる', async () => {
    const { reserveStorageUsage } = await prime({ userUsage: 0, globalUsage: 0 })
    vi.mocked(reserveStorageUsage).mockResolvedValue({
      reservationId: null,
      outcome: 'reserved',
      degraded: true,
    })

    const { reserveStorageCapacity } = await import('@/lib/storage-usage')
    await expect(reserveStorageCapacity('prefix12', 'twitch-user-123', 1234)).resolves.toEqual({
      ok: true,
      reservationId: null,
      degraded: true,
    })
  })
})

describe('formatBytes', () => {
  // 現行の実利用は非負の B〜GB 範囲なので、その契約だけを直接固定する。
  // 負数や TB 以上をどう表現するかは別途仕様判断が必要なため、このテストでは既存挙動を固定しない。
  it.each([
    { bytes: 0, expected: '0 B' },
    { bytes: 1023, expected: '1023 B' },
    { bytes: 1024, expected: '1 KB' },
    { bytes: 1536, expected: '1.5 KB' },
    { bytes: 1024 ** 2, expected: '1 MB' },
    { bytes: 1024 ** 3, expected: '1 GB' },
    { bytes: 50 * 1024 ** 3, expected: '50 GB' },
  ])('formats $bytes bytes as $expected', async ({ bytes, expected }) => {
    const { formatBytes } = await import('@/lib/storage-usage')

    expect(formatBytes(bytes)).toBe(expected)
  })
})
