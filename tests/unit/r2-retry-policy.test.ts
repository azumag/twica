import { describe, expect, it } from 'vitest'
import { CLOUDFLARE_R2_TRANSIENT_MARKERS } from '@/lib/r2-retry-policy'
import { isTransientR2Error } from '@/lib/r2-client'

// CLOUDFLARE_R2_TRANSIENT_MARKERS は、Cloudflare R2固有のエラーコードのうち
// 「一時障害としてリトライすべきもの」の単一の情報源(single source of truth)。
// 実際のリトライループと判定関数（isTransientR2Error）はr2-client.ts側に一本化されている
// （Issue #980でこのファイルにあった isTransientCloudflareR2Error / retryCloudflareR2Upload
// は撤去済み）。ここでは「マーカー一覧に想定するコードが登録されているか」というデータの
// 内容だけを検証し、判定ロジック自体のテストはr2-client-transient-error.test.tsに委ねる
// （同じ判定ロジックを2箇所でテストする重複を避ける）。
describe('CLOUDFLARE_R2_TRANSIENT_MARKERS', () => {
  it('Cloudflare R2のInternalError (10001) を含む (Issue #976/#977)', () => {
    expect(CLOUDFLARE_R2_TRANSIENT_MARKERS).toContain('(10001)')
  })

  it('Cloudflare R2のServiceUnavailable (10043) を含む', () => {
    expect(CLOUDFLARE_R2_TRANSIENT_MARKERS).toContain('(10043)')
  })

  it('r2-client.tsのisTransientR2Errorがこのマーカー一覧をimportして使っている（単一の情報源であることの回帰確認）', () => {
    // マーカー一覧に無い架空のコードは一時障害と判定されないはずだが、
    // 一覧に追加すればisTransientR2Error側の判定にも反映される（二重管理の再発防止）
    expect(isTransientR2Error('put: unrecognized error (99999)')).toBe(false)
    expect(isTransientR2Error(`put: internal error ${CLOUDFLARE_R2_TRANSIENT_MARKERS[0]}`)).toBe(true)
  })
})
