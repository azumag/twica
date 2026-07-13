import { describe, expect, it, vi } from 'vitest'
import { isTransientCloudflareR2Error, retryCloudflareR2Upload } from '@/lib/r2-retry-policy'

describe('R2 retry policy', () => {
  it('Cloudflare R2 error 10043を一時障害として扱う', () => {
    expect(isTransientCloudflareR2Error('put: Please look at https://www.cloudflarestatus.com for issues or contact customer support. (10043)')).toBe(true)
  })

  it('認証エラーなど恒久障害は再試行対象にしない', () => {
    expect(isTransientCloudflareR2Error('AccessDenied: invalid credentials')).toBe(false)
  })

  it('10043の後に成功した場合は再実行する', async () => {
    const upload = vi.fn<() => Promise<{ url?: string; error?: string }>>()
      .mockResolvedValueOnce({ error: 'put failed (10043)' })
      .mockResolvedValueOnce({ url: 'https://example.test/image.png' })
    const sleep = vi.fn().mockResolvedValue(undefined)

    await expect(retryCloudflareR2Upload(upload, 2, sleep)).resolves.toEqual({ url: 'https://example.test/image.png' })
    expect(upload).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(500)
  })

  it('非一時エラーは再試行しない', async () => {
    const upload = vi.fn().mockResolvedValue({ error: 'AccessDenied' })
    const sleep = vi.fn().mockResolvedValue(undefined)

    await expect(retryCloudflareR2Upload(upload, 2, sleep)).resolves.toEqual({ error: 'AccessDenied' })
    expect(upload).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })
})
