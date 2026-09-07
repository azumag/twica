import { describe, expect, it } from 'vitest'
import { isTransientR2Error } from '@/lib/r2-client'

// Issue #989: URL の path に偶然 503 が含まれるだけでは HTTP status 503 ではない。
// 明示的な status grammar と短い URL を対にして、裸の数字部分文字列へ戻る退行を防ぐ。
describe('isTransientR2Error: URL中の503誤検知回帰 (#989)', () => {
  it('短いURLの /503 は一時障害として扱わない', () => {
    expect(isTransientR2Error('PUT http://a/503 failed')).toBe(false)
  })

  it('HTTP status line の503は一時障害として扱う', () => {
    expect(isTransientR2Error('PUT http://a/upload failed: HTTP/1.1 503')).toBe(true)
  })
})
