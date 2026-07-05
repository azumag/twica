import { describe, it, expect } from 'vitest'
import {
  isPgFunctionNotFoundError,
  isPgMissingColumnError,
  isPgMissingTableError,
  isPgUniqueViolationError,
} from '@/lib/db/errors'

/** postgres.js が throw するエラー（code = SQLSTATE）を模倣する */
function pgError(code: string): Error & { code: string } {
  return Object.assign(new Error(`SQLSTATE ${code}`), { code })
}

describe('db/errors SQLSTATE 判定', () => {
  it('isPgMissingColumnError: 42703 のみ true', () => {
    expect(isPgMissingColumnError(pgError('42703'))).toBe(true)
    expect(isPgMissingColumnError(pgError('42P01'))).toBe(false)
    expect(isPgMissingColumnError(pgError('23505'))).toBe(false)
  })

  it('isPgFunctionNotFoundError: 42883 のみ true', () => {
    expect(isPgFunctionNotFoundError(pgError('42883'))).toBe(true)
    expect(isPgFunctionNotFoundError(pgError('42703'))).toBe(false)
  })

  it('isPgUniqueViolationError: 23505 のみ true', () => {
    expect(isPgUniqueViolationError(pgError('23505'))).toBe(true)
    expect(isPgUniqueViolationError(pgError('23503'))).toBe(false)
  })

  it('isPgMissingTableError: 42P01 のみ true', () => {
    expect(isPgMissingTableError(pgError('42P01'))).toBe(true)
    expect(isPgMissingTableError(pgError('42703'))).toBe(false)
  })
})

describe('db/errors unknown 安全性', () => {
  const guards = [
    isPgMissingColumnError,
    isPgFunctionNotFoundError,
    isPgUniqueViolationError,
    isPgMissingTableError,
  ]

  it.each(guards.map((g) => [g.name, g] as const))(
    '%s は null / undefined / 文字列 / code なしでも例外を出さず false',
    (_name, guard) => {
      expect(guard(null)).toBe(false)
      expect(guard(undefined)).toBe(false)
      expect(guard('42703')).toBe(false)
      expect(guard(42703)).toBe(false)
      expect(guard(new Error('no code'))).toBe(false)
      // code が数値（SQLSTATE は文字列でなければならない）
      expect(guard(Object.assign(new Error('x'), { code: 42703 }))).toBe(false)
    }
  )
})
