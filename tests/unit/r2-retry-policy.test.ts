import { describe, expect, it } from 'vitest'
import { CLOUDFLARE_R2_TRANSIENT_MARKERS } from '@/lib/r2-retry-policy'

// CLOUDFLARE_R2_TRANSIENT_MARKERS は、Cloudflare R2固有のエラーコードのうち
// 「一時障害としてリトライすべきもの」の単一の情報源(single source of truth)。
// 実際の判定ロジック（isTransientR2Error）はr2-client.ts側に一本化されている
// （Issue #980でこのファイルにあった isTransientCloudflareR2Error / retryCloudflareR2Upload
// は撤去済み）。ここではマーカー一覧という「データ」自体の内容だけを検証する。
// このマーカーを使った判定の実際の挙動（isTransientR2Errorが真を返すか）は
// tests/unit/r2-client-transient-error.test.ts に委ね、同じ判定ロジックを
// 2箇所でテストする重複を避ける。
describe('CLOUDFLARE_R2_TRANSIENT_MARKERS', () => {
  it('Cloudflare R2のInternalError (10001) を含む (Issue #976/#977)', () => {
    expect(CLOUDFLARE_R2_TRANSIENT_MARKERS).toContain('(10001)')
  })

  it('Cloudflare R2のServiceUnavailable (10043) を含む', () => {
    expect(CLOUDFLARE_R2_TRANSIENT_MARKERS).toContain('(10043)')
  })
})
