import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isTransientCloudflareR2Error, retryCloudflareR2Upload } from '@/lib/r2-retry-policy'

// r2-retry-policy.tsはserver-only loggerを使う。ここでも同じentry pointをmockし、
// 再試行のwarnログが実コンソールへ漏れてテスト出力を汚さないようにする。
// vi.mockのfactoryはimportより前に巻き上げられるため、参照する変数はvi.hoisted内で
// 宣言する必要がある（そうしないとTDZ違反でエラーになる）
const { logger } = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/logger.server', () => ({
  logger,
}))

describe('R2 retry policy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('Cloudflare R2 error 10043を一時障害として扱う', () => {
    expect(isTransientCloudflareR2Error('put: Please look at https://www.cloudflarestatus.com for issues or contact customer support. (10043)')).toBe(true)
  })

  it('認証エラーなど恒久障害は再試行対象にしない', () => {
    expect(isTransientCloudflareR2Error('AccessDenied: invalid credentials')).toBe(false)
  })

  it('Cloudflare R2 error 10001（InternalError）を一時障害として扱う (#976, #977)', () => {
    expect(isTransientCloudflareR2Error('put: We encountered an internal error. Please try again. (10001)')).toBe(true)
  })

  it('10043の後に成功した場合は再実行する', async () => {
    const upload = vi.fn<() => Promise<{ url?: string; error?: string }>>()
      .mockResolvedValueOnce({ error: 'put failed (10043)' })
      .mockResolvedValueOnce({ url: 'https://example.test/image.png' })
    const sleep = vi.fn().mockResolvedValue(undefined)

    await expect(retryCloudflareR2Upload(upload, 2, sleep)).resolves.toEqual({ url: 'https://example.test/image.png' })
    expect(upload).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(500)
    expect(logger.warn).toHaveBeenCalledWith(
      '[R2] Transient error, retrying (attempt 1/3):',
      'put failed (10043)'
    )
  })

  it('10001の後に成功した場合は再実行する (#976, #977)', async () => {
    const upload = vi.fn<() => Promise<{ url?: string; error?: string }>>()
      .mockResolvedValueOnce({ error: 'put: We encountered an internal error. Please try again. (10001)' })
      .mockResolvedValueOnce({ url: 'https://example.test/sound.mp3' })
    const sleep = vi.fn().mockResolvedValue(undefined)

    await expect(retryCloudflareR2Upload(upload, 2, sleep)).resolves.toEqual({ url: 'https://example.test/sound.mp3' })
    expect(upload).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(500)
  })

  it('非一時エラーは再試行しない', async () => {
    const upload = vi.fn().mockResolvedValue({ error: 'AccessDenied' })
    const sleep = vi.fn().mockResolvedValue(undefined)

    await expect(retryCloudflareR2Upload(upload, 2, sleep)).resolves.toEqual({ error: 'AccessDenied' })
    expect(upload).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('再試行を使い切っても一時障害が続く場合はその旨を警告し、最後の結果を返す', async () => {
    const upload = vi.fn().mockResolvedValue({ error: 'put failed (10043)' })
    const sleep = vi.fn().mockResolvedValue(undefined)

    await expect(retryCloudflareR2Upload(upload, 2, sleep)).resolves.toEqual({ error: 'put failed (10043)' })
    // 初回 + maxRetries(2)回 = 計3回試行する
    expect(upload).toHaveBeenCalledTimes(3)
    expect(logger.warn).toHaveBeenCalledWith(
      '[R2] Transient error persisted after 3 attempts:',
      'put failed (10043)'
    )
  })
})
