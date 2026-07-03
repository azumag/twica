import { describe, expect, it } from 'vitest'
import { isMissingCardIssuanceColumnError, parseCardIssuanceLimit } from '@/lib/card-issuance'

describe('parseCardIssuanceLimit', () => {
  it('treats empty values as unlimited', () => {
    expect(parseCardIssuanceLimit(undefined)).toBeNull()
    expect(parseCardIssuanceLimit(null)).toBeNull()
    expect(parseCardIssuanceLimit('')).toBeNull()
  })

  it('accepts positive integers', () => {
    expect(parseCardIssuanceLimit(1)).toBe(1)
    expect(parseCardIssuanceLimit(100)).toBe(100)
  })

  it('rejects non-positive or non-integer values', () => {
    expect(parseCardIssuanceLimit(0)).toBe('invalid')
    expect(parseCardIssuanceLimit(-1)).toBe('invalid')
    expect(parseCardIssuanceLimit(1.5)).toBe('invalid')
    expect(parseCardIssuanceLimit('100')).toBe('invalid')
  })

  // R4 (PR #450 レビュー follow-up): cards.max_issuance_count はDB側で4バイト
  // PostgreSQL INTEGER(最大2,147,483,647)。上限なしで受け付けると桁あふれで
  // 22003エラー→opaqueな500になるため、製品として現実的な上限
  // (1,000,000)でアプリ層が先に弾く。
  it('rejects values above the product cap (1,000,000) to avoid PostgreSQL INTEGER overflow (22003)', () => {
    expect(parseCardIssuanceLimit(1e12)).toBe('invalid')
    expect(parseCardIssuanceLimit(1_000_001)).toBe('invalid')
    // INTEGER自体の最大値を大きく超える入力も同様に拒否される
    expect(parseCardIssuanceLimit(2_147_483_648)).toBe('invalid')
  })

  it('accepts the product cap itself (1,000,000)', () => {
    expect(parseCardIssuanceLimit(1_000_000)).toBe(1_000_000)
  })
})

describe('isMissingCardIssuanceColumnError', () => {
  it('detects PostgREST schema-cache errors for max_issuance_count', () => {
    expect(isMissingCardIssuanceColumnError({
      code: 'PGRST204',
      message: "Could not find the 'max_issuance_count' column of 'cards' in the schema cache",
    })).toBe(true)
  })

  it('ignores unrelated missing-column errors', () => {
    expect(isMissingCardIssuanceColumnError({
      code: 'PGRST204',
      message: "Could not find the 'card_number' column of 'cards' in the schema cache",
    })).toBe(false)
  })
})
