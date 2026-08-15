import { describe, expect, it } from 'vitest'
import { isTransientR2UploadError, isTransientR2SoundUploadError } from '@/lib/r2-client'

// uploadToR2WithRetry / uploadSoundToR2WithRetry の一時障害判定ロジック。
// Issue #976/#977: R2のInternalError(10001)が未登録だったため、本番で
// リトライ可能なはずのアップロード失敗が即座にエラー化していた。
//
// 画像用（isTransientR2UploadError）はretryCloudflareR2Upload（r2-retry-policy.ts）で
// 二重にラップされるため、R2固有のエラーコードはそちら側のみで判定し、ここには含めない
// （二重リトライによる待ち時間の肥大化を防ぐ）。効果音用（isTransientR2SoundUploadError）は
// 外側のラップが無い唯一のリトライ層なので、R2固有のエラーコードもここで判定する。
describe('isTransientR2UploadError（画像アップロード用）', () => {
  it('ネットワーク系エラーを一時障害として扱う', () => {
    expect(isTransientR2UploadError('connect ECONNRESET')).toBe(true)
  })

  it('R2ネイティブバインディングのUnspecified errorを一時障害として扱う (Issue #349/#348)', () => {
    expect(isTransientR2UploadError('Unspecified error')).toBe(true)
  })

  it('R2固有のエラーコード(10001)はここでは一時障害として扱わない（外側のretryCloudflareR2Uploadが担当、二重リトライ防止）', () => {
    expect(isTransientR2UploadError('put: We encountered an internal error. Please try again. (10001)')).toBe(false)
  })

  it('認証エラーなど恒久障害は一時障害として扱わない', () => {
    expect(isTransientR2UploadError('AccessDenied: invalid credentials')).toBe(false)
  })
})

describe('isTransientR2SoundUploadError（効果音アップロード用）', () => {
  it('R2のInternalError (10001) を一時障害として扱う (Issue #976/#977と同種)', () => {
    expect(isTransientR2SoundUploadError('put: We encountered an internal error. Please try again. (10001)')).toBe(true)
  })

  it('R2のServiceUnavailable (10043) を一時障害として扱う', () => {
    expect(isTransientR2SoundUploadError('put: Please look at https://www.cloudflarestatus.com (10043)')).toBe(true)
  })

  it('ネットワーク系エラーを一時障害として扱う', () => {
    expect(isTransientR2SoundUploadError('connect ECONNRESET')).toBe(true)
  })

  it('認証エラーなど恒久障害は一時障害として扱わない', () => {
    expect(isTransientR2SoundUploadError('AccessDenied: invalid credentials')).toBe(false)
  })
})
