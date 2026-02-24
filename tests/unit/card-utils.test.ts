import { describe, it, expect } from 'vitest'
import { normalizeDropRate } from '@/lib/card-utils'

describe('normalizeDropRate', () => {
  it('should convert string drop_rate to number', () => {
    const cards = [{ id: '1', drop_rate: '0.5' as unknown }]
    const result = normalizeDropRate(cards)
    expect(result[0].drop_rate).toBe(0.5)
    expect(typeof result[0].drop_rate).toBe('number')
  })

  it('should keep numeric drop_rate as-is', () => {
    const cards = [{ id: '1', drop_rate: 0.75 as unknown }]
    const result = normalizeDropRate(cards)
    expect(result[0].drop_rate).toBe(0.75)
  })

  it('should fallback to 0 for null drop_rate', () => {
    const cards = [{ id: '1', drop_rate: null as unknown }]
    const result = normalizeDropRate(cards)
    expect(result[0].drop_rate).toBe(0)
  })

  it('should fallback to 0 for undefined drop_rate', () => {
    const cards = [{ id: '1', drop_rate: undefined as unknown }]
    const result = normalizeDropRate(cards)
    expect(result[0].drop_rate).toBe(0)
  })

  it('should fallback to 0 for empty string drop_rate', () => {
    const cards = [{ id: '1', drop_rate: '' as unknown }]
    const result = normalizeDropRate(cards)
    expect(result[0].drop_rate).toBe(0)
  })

  it('should fallback to 0 for non-numeric string drop_rate', () => {
    const cards = [{ id: '1', drop_rate: 'abc' as unknown }]
    const result = normalizeDropRate(cards)
    expect(result[0].drop_rate).toBe(0)
  })

  it('should return empty array for empty input', () => {
    const result = normalizeDropRate([])
    expect(result).toEqual([])
  })

  it('should preserve other properties of each card', () => {
    const cards = [{ id: '1', name: 'Test Card', drop_rate: '0.3' as unknown, rarity: 'rare' }]
    const result = normalizeDropRate(cards)
    expect(result[0].id).toBe('1')
    expect(result[0].name).toBe('Test Card')
    expect(result[0].rarity).toBe('rare')
    expect(result[0].drop_rate).toBe(0.3)
  })

  it('should handle multiple cards', () => {
    const cards = [
      { id: '1', drop_rate: '0.5' as unknown },
      { id: '2', drop_rate: 0.3 as unknown },
      { id: '3', drop_rate: null as unknown },
    ]
    const result = normalizeDropRate(cards)
    expect(result.map(c => c.drop_rate)).toEqual([0.5, 0.3, 0])
  })

  it('should handle drop_rate of exactly 0 (valid value, not fallback)', () => {
    // Number(0) is 0, and 0 || 0 is also 0. This is correct behavior.
    const cards = [{ id: '1', drop_rate: 0 as unknown }]
    const result = normalizeDropRate(cards)
    expect(result[0].drop_rate).toBe(0)
  })
})
