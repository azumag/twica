import { describe, expect, it } from 'vitest'
import { isTransientR2Error } from '@/lib/r2-client'

// Issue #989: 旧判定は文脈語と 503 の距離を \D{0,10} で制限していたため、
// provider が空白を多めに入れただけでも一時障害を取りこぼし得た。
// 現行の明示的な status grammar が任意の文字列距離ではなく構文で判定することを固定する。
describe('isTransientR2Error: HTTP status grammar distance regression (#989)', () => {
  it('status code と 503 の間が11文字を超える空白でも一時障害として扱う', () => {
    expect(isTransientR2Error(`request failed with status code:${' '.repeat(16)}503`)).toBe(true)
  })

  it('status と 503 の間に未定義の語が入る場合は一時障害として扱わない', () => {
    expect(isTransientR2Error('request failed with status metadata 503')).toBe(false)
  })
})
