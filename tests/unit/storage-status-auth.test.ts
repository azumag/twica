import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GET } from '@/app/api/storage-status/route'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { getStorageUsage } from '@/lib/storage-usage'
import { sha256Prefix } from '@/lib/crypto-utils'
import { ERROR_MESSAGES } from '@/lib/constants'

/**
 * Issue #1352: storage-status は未認証と配信者機能を使えないセッションを
 * 同じ 401 契約で拒否する。ここでは認証完了前に storage 読み取りへ進まない
 * 境界も含め、既存 API 契約として意図的に固定する。
 */
vi.mock('@/lib/session')
vi.mock('@/lib/storage-usage')
vi.mock('@/lib/crypto-utils')

const SESSION = {
  twitchUserId: 'viewer-twitch-id',
  twitchUsername: 'viewer',
  twitchDisplayName: 'Viewer',
  twitchProfileImageUrl: '',
  broadcasterType: '',
  expiresAt: Date.now() + 100_000,
  version: 1 as const,
}

describe('GET /api/storage-status auth contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getSession).mockResolvedValue(SESSION)
    vi.mocked(canUseStreamerFeatures).mockReturnValue(true)
  })

  it('未認証なら 401 を返し storage 読み取りへ進まない', async () => {
    vi.mocked(getSession).mockResolvedValue(null)

    const response = await GET()

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: ERROR_MESSAGES.UNAUTHORIZED })
    expect(canUseStreamerFeatures).not.toHaveBeenCalled()
    expect(sha256Prefix).not.toHaveBeenCalled()
    expect(getStorageUsage).not.toHaveBeenCalled()
  })

  it('配信者機能を使えないセッションでも 401 を返し storage 読み取りへ進まない', async () => {
    vi.mocked(canUseStreamerFeatures).mockReturnValue(false)

    const response = await GET()

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: ERROR_MESSAGES.UNAUTHORIZED })
    expect(canUseStreamerFeatures).toHaveBeenCalledWith(SESSION)
    expect(sha256Prefix).not.toHaveBeenCalled()
    expect(getStorageUsage).not.toHaveBeenCalled()
  })
})
