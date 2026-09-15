import { describe, expect, it } from 'vitest'
import { safeParseInt } from '@/lib/parse'

describe('safeParseInt', () => {
  it.each([
    [null, 12],
    ['abc', 12],
    ['0', 12],
    ['-1', 12],
  ] as const)('falls back to the default for invalid or sub-one input %s', (value, expected) => {
    expect(safeParseInt(value, 12)).toBe(expected)
  })

  it.each([
    ['1', 1],
    ['42', 42],
    ['1000', 1000],
  ] as const)('parses positive integer input %s', (value, expected) => {
    expect(safeParseInt(value, 12)).toBe(expected)
  })
})
