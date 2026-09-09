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
vi.mock('@/lib/crypto-utils')

const mockGetSession = vi.mocked(getSession)
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures)
const mockGetStorageUsage = vi.mocked(getStorageUsage)
const mockFormatBytes = vi.mocked(formatBytes)
const mockSha256Prefix = vi.mocked(sha256Prefix)

// 認証済みfixtureは実行時刻に依存させず、十分未来の固定時刻で有効状態を表現する。
const SESSION_EXPIRES_AT = Date.UTC(2100, 0, 1)

const baseUsage: StorageUsage = {
  userUsage: 1024,
  globalUsage: 2048,
  userLimitReached: false,
  globalLimitReached: false,
  userLimitBytes: 10 * 1024 * 1024,
  globalLimitBytes: 50 * 1024 * 1024 * 1024,
  planOverLimit: false,
}

// このsuiteは200応答の本文互換だけを検証するため、成功statusのassertionはhelperに集約する。
// 401/500のstatus契約は専用suiteで固定し、各テストはmessage優先順位へ集中させる（#1352）。
async function getSuccessfulStorageStatusBody(overrides: Partial<StorageUsage> = {}) {
  mockGetStorageUsage.mockResolvedValue({ ...baseUsage, ...overrides })
  const response = await GET()
  expect(response.status).toBe(200)
  return response.json() as Promise<{ message: string | null }>
}

// 互換契約の退行を検知するため、production の定数を参照せず期待文字列をリテラルで固定する。
// 定数側の文言変更へテストも同時追従すると、未知クライアント向け message の意図しない変更を検知できない。
// この契約が失敗した場合はテストを機械的に追従させず、まず production 側の意図しない互換破壊として戻すかを確認する。
// 変更が意図的なら外部互換性を評価・記録した契約変更として、production と期待値を同時に更新する（#1352）。
describe('GET /api/storage-status message compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSession.mockResolvedValue({
      twitchUserId: 'test-user-id',
      twitchUsername: 'test-user',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/avatar.jpg',
      broadcasterType: 'affiliate',
      expiresAt: SESSION_EXPIRES_AT,
      version: 1,
    })
    mockCanUseStreamerFeatures.mockReturnValue(true)
    mockSha256Prefix.mockResolvedValue('12345678')
    mockFormatBytes.mockImplementation((bytes) => `${bytes} B`)
  })

  it('planOverLimit を最優先の互換 message として返す', async () => {
    const body = await getSuccessfulStorageStatusBody({
      planOverLimit: true,
      globalLimitReached: true,
      userLimitReached: true,
    })

    expect(body.message).toBe(
      'ストレージ容量を超過しています。支援特典をアップグレードするか、画像を削除してください。'
    )
  })

  it('globalLimitReached を userLimitReached より優先する', async () => {
    const body = await getSuccessfulStorageStatusBody({
      globalLimitReached: true,
      userLimitReached: true,
    })

    expect(body.message).toBe('画像のアップロード上限に達しました。')
  })

  it('userLimitReached の互換 message を返す', async () => {
    const body = await getSuccessfulStorageStatusBody({ userLimitReached: true })

    expect(body.message).toBe(
      '画像のアップロード上限は現在一アカウントにつき10MBです。上限を超える場合は、既存の画像を削除してから再度お試しください。'
    )
  })

  it('制限に達していなければ message は null を返す', async () => {
    const body = await getSuccessfulStorageStatusBody()

    expect(body.message).toBeNull()
  })
})
