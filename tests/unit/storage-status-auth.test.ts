import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GET } from '@/app/api/storage-status/route'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { getStorageUsage } from '@/lib/storage-usage'
import { sha256Prefix } from '@/lib/crypto-utils'
import { ERROR_MESSAGES } from '@/lib/constants'

vi.mock('@/lib/session')
vi.mock('@/lib/storage-usage')
vi.mock('@/lib/crypto-utils')

const SESSION_EXPIRES_AT = Date.UTC(2100, 0, 1)

const SESSION = {
  twitchUserId: 'viewer-twitch-id',
  twitchUsername: 'viewer',
  twitchDisplayName: 'Viewer',
  twitchProfileImageUrl: '',
  broadcasterType: '',
  expiresAt: SESSION_EXPIRES_AT,
  version: 1,
}

// #1352: This contract keeps auth rejection at the route boundary: missing or
// ineligible sessions must fail before user identifiers are hashed or storage is read.
// #1569: 認証済みで配信者機能を利用できない場合は 401 ではなく 403 (Forbidden) を返す契約へ更新した。
// 401 は「認証情報が無い」ことを表し、権限不足（再認証では解消しない）を 401 で返すと
// 未知クライアントに再認証ループを誘発しうるため。同じ storage 機能の /api/upload 系と同じ境界に揃える。
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
    // canUseStreamerFeatures() の内部呼び出し順序はこの境界契約に含めず、
    // 未認証で hash / storage I/O へ進まないことだけを固定する。
    expect(sha256Prefix).not.toHaveBeenCalled()
    expect(getStorageUsage).not.toHaveBeenCalled()
  })

  it('配信者機能を使えないセッションは 403 を返し storage 読み取りへ進まない', async () => {
    vi.mocked(canUseStreamerFeatures).mockReturnValue(false)

    const response = await GET()

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: ERROR_MESSAGES.FORBIDDEN })
    expect(canUseStreamerFeatures).toHaveBeenCalledWith(SESSION)
    expect(sha256Prefix).not.toHaveBeenCalled()
    expect(getStorageUsage).not.toHaveBeenCalled()
  })
})
