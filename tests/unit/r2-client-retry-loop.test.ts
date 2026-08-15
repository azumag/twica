import { describe, expect, it, vi } from 'vitest'
import { withR2UploadRetry } from '@/lib/r2-client'

// uploadToR2WithRetry / uploadSoundToR2WithRetry が共通で使うリトライループ本体
// （withR2UploadRetry）の動作テスト。
//
// 【Issue #980】以前はuploadToR2WithRetryのループ相当の動作は、r2-retry-policy.tsの
// retryCloudflareR2Upload（upload/sleepを引数として注入できる設計だった）が
// tests/unit/r2-retry-policy.test.ts でテストされていたが、二重リトライ撤去に伴い
// retryCloudflareR2Uploadごと削除された。isTransientR2Error（一時障害かどうかの
// 判定関数）が真を返すことのテスト（r2-client-transient-error.test.ts）だけでは
// 「実際にリトライされて成功する／恒久障害では再試行しない／上限で打ち切る」という
// ループそのものの挙動は検証できないため、withR2UploadRetryをexportしてここで
// 直接テストする（sleepを注入し、実際の待機なしで検証する）。
describe('withR2UploadRetry', () => {
  it('一時障害（R2固有エラーコード）が続いた後に成功すれば、最終的に成功を返す', async () => {
    const upload = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('put: internal error (10001)'))
      .mockRejectedValueOnce(new Error('put: internal error (10001)'))
      .mockResolvedValueOnce('https://example.test/image.png')
    const sleep = vi.fn().mockResolvedValue(undefined)

    await expect(withR2UploadRetry('[R2]', upload, 3, sleep)).resolves.toEqual({
      url: 'https://example.test/image.png',
    })
    expect(upload).toHaveBeenCalledTimes(3)
    // 指数バックオフ: 1回目のリトライ前に1000ms、2回目のリトライ前に2000ms
    expect(sleep).toHaveBeenNthCalledWith(1, 1000)
    expect(sleep).toHaveBeenNthCalledWith(2, 2000)
  })

  it('恒久的なエラー（認証エラー等）は再試行せず即座にエラーを返す', async () => {
    const upload = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('AccessDenied: invalid credentials'))
    const sleep = vi.fn().mockResolvedValue(undefined)

    await expect(withR2UploadRetry('[R2]', upload, 3, sleep)).resolves.toEqual({
      error: 'AccessDenied: invalid credentials',
    })
    expect(upload).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('一時障害がmaxRetries回を超えて続く場合は、最大試行回数(maxRetries+1回)で打ち切りエラーを返す', async () => {
    const upload = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('connect ECONNRESET'))
    const sleep = vi.fn().mockResolvedValue(undefined)

    await expect(withR2UploadRetry('[R2]', upload, 2, sleep)).resolves.toEqual({
      error: 'connect ECONNRESET',
    })
    // maxRetries=2 なら初回+2リトライ=最大3回試行
    expect(upload).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('maxRetries=0（リトライ無効）なら、一時障害でも1回で打ち切る', async () => {
    const upload = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('connect ECONNRESET'))
    const sleep = vi.fn().mockResolvedValue(undefined)

    await expect(withR2UploadRetry('[R2]', upload, 0, sleep)).resolves.toEqual({
      error: 'connect ECONNRESET',
    })
    expect(upload).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })
})
