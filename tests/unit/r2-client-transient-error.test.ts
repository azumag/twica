import { describe, expect, it } from 'vitest'
import { isTransientR2Error } from '@/lib/r2-client'

// uploadToR2WithRetry / uploadSoundToR2WithRetry の一時障害判定ロジック。
// Issue #976/#977: R2のInternalError(10001)が未登録だったため、本番で
// リトライ可能なはずのアップロード失敗が即座にエラー化していた。
describe('isTransientR2Error', () => {
  it('R2のInternalError (10001) を一時障害として扱う (Issue #976/#977)', () => {
    expect(isTransientR2Error('put: We encountered an internal error. Please try again. (10001)')).toBe(true)
  })

  it('R2のServiceUnavailable (10043) を一時障害として扱う', () => {
    expect(isTransientR2Error('put: Please look at https://www.cloudflarestatus.com (10043)')).toBe(true)
  })

  it('R2ネイティブバインディングのUnspecified errorを一時障害として扱う (Issue #349/#348)', () => {
    expect(isTransientR2Error('Unspecified error')).toBe(true)
  })

  it('ネットワーク系エラーを一時障害として扱う', () => {
    expect(isTransientR2Error('connect ECONNRESET')).toBe(true)
  })

  it('認証エラーなど恒久障害は一時障害として扱わない', () => {
    expect(isTransientR2Error('AccessDenied: invalid credentials')).toBe(false)
  })
})
