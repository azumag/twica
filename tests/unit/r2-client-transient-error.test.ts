import { describe, expect, it } from 'vitest'
import { isTransientR2Error } from '@/lib/r2-client'
import { CLOUDFLARE_R2_TRANSIENT_MARKERS } from '@/lib/r2-retry-policy'

// uploadToR2WithRetry / uploadSoundToR2WithRetry の一時障害判定ロジック。
// Issue #976/#977: R2のInternalError(10001)が未登録だったため、本番で
// リトライ可能なはずのアップロード失敗が即座にエラー化していた。
//
// 【Issue #980】以前は画像用・効果音用で別々のパターンリストを持っていた
// （画像アップロードは呼び出し元でさらに二重にリトライラップされていたため、
// R2固有のエラーコードを画像側の判定からわざと除外していた）。その二重ラップ
// （src/app/api/upload/route.ts の retryCloudflareR2Upload）自体を撤去したので、
// 画像・効果音とも isTransientR2Error 1本で判定する（差異なし）。
describe('isTransientR2Error', () => {
  it('ネットワーク系エラーを一時障害として扱う', () => {
    expect(isTransientR2Error('connect ECONNRESET')).toBe(true)
  })

  it('R2ネイティブバインディングのUnspecified errorを一時障害として扱う (Issue #349/#348)', () => {
    expect(isTransientR2Error('Unspecified error')).toBe(true)
  })

  it('認証エラーなど恒久障害は一時障害として扱わない', () => {
    expect(isTransientR2Error('AccessDenied: invalid credentials')).toBe(false)
  })

  it('service unavailableという文言を一時障害として扱う', () => {
    expect(isTransientR2Error('put: service unavailable, please retry')).toBe(true)
  })

  it('HTTPステータス表記の503（"HTTP 503"）を一時障害として扱う', () => {
    expect(isTransientR2Error('Request failed with HTTP 503')).toBe(true)
  })

  it('HTTPステータス表記の503（"status: 503"）を一時障害として扱う', () => {
    expect(isTransientR2Error('put: status: 503, please retry later')).toBe(true)
  })

  it.each([
    'Request failed with HTTP/1.1 503',
    'Request failed with HTTP/2 503',
    'put: status code=503, please retry later',
    'SDK response: statusCode=503',
    'SDK response: httpStatusCode: 503',
  ])('標準的なHTTP status表記%sを一時障害として扱う (Issue #989)', (errorMessage) => {
    expect(isTransientR2Error(errorMessage)).toBe(true)
  })

  // 【Issue #989/#1397】status文脈の無い数値やURL中の数値、区切りのないstatus503、
  // quoted JSON keyのstatusCodeは標準的なHTTP status表記とはみなさず、一時障害にしない。
  // 特に短いURLは旧\D{0,10}実装で誤って一致していたため、偽陽性境界を負例で固定する。
  it.each([
    '503',
    'PUT http://a/503 failed',
    'Request failed with HTTP 5030',
    'SDK response: statusCode=5030',
    'SDK response from myhttp 503',
    'status503',
    '{"statusCode":503}',
  ])('標準的なstatus文脈のない503を一時障害として扱わない: %s', (errorMessage) => {
    expect(isTransientR2Error(errorMessage)).toBe(false)
  })

  // 【Issue #984/#1252】裸の'503'部分文字列マッチは、キー名やリクエストIDに偶然数字列を含む
  // 恒久エラーを誤って一時障害と判定するリスクがあった。500は現状リトライ対象外だが、
  // HTTP statusの文脈が無い数字列を扱わない負例として503とあわせて固定する。
  it.each(['500', '503'])(
    'キー名にたまたま%sを含む恒久エラーは一時障害として扱わない (Issue #984)',
    (numericToken) => {
      expect(isTransientR2Error(`AccessDenied: key 'photo-${numericToken}.png' is not permitted`)).toBe(false)
    },
  )

  // r2-retry-policy.tsのCLOUDFLARE_R2_TRANSIENT_MARKERSをここから直接importして
  // 全要素をループ検証する。ハードコピーした文字列リテラルではなく実際にimportした
  // 配列を使うことで、「単一の情報源をimportして使っている」こと自体を検証する
  // （マーカーを追加してもここを更新し忘れない、二重管理の再発防止）。
  it.each(CLOUDFLARE_R2_TRANSIENT_MARKERS)('Cloudflare R2固有のマーカー%sを一時障害として扱う (Issue #976/#977)', (marker) => {
    expect(isTransientR2Error(`put: error ${marker}`)).toBe(true)
  })
})
