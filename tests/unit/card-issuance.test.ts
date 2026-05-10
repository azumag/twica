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
