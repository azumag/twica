import { describe, expect, it } from 'vitest'
import { isTransientCloudflareR2Error } from '@/lib/r2-retry-policy'

// CLOUDFLARE_R2_TRANSIENT_MARKERS / isTransientCloudflareR2Error は、Cloudflare R2固有の
// エラーコードのうち「一時障害としてリトライすべきもの」の単一の情報源(single source of
// truth)。実際のリトライループはr2-client.tsのuploadToR2WithRetry/uploadSoundToR2WithRetry
// 側にあり（Issue #980でこのファイルにあった二重ラップretryCloudflareR2Uploadは撤去済み）、
// そちらから本モジュールのマーカー一覧をimportして使う。
describe('isTransientCloudflareR2Error', () => {
  it('Cloudflare R2 error 10043を一時障害として扱う', () => {
    expect(isTransientCloudflareR2Error('put: Please look at https://www.cloudflarestatus.com for issues or contact customer support. (10043)')).toBe(true)
  })

  it('Cloudflare R2 error 10001（InternalError）を一時障害として扱う (Issue #976/#977)', () => {
    expect(isTransientCloudflareR2Error('put: We encountered an internal error. Please try again. (10001)')).toBe(true)
  })

  it('認証エラーなど恒久障害は再試行対象にしない', () => {
    expect(isTransientCloudflareR2Error('AccessDenied: invalid credentials')).toBe(false)
  })
})
