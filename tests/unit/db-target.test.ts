/**
 * #693: src/lib/db/target.ts（DB_TARGET フラグ解決）のテスト
 *
 * flags.ts の getDbDriverMode() と同じ「呼び出しのたびに process.env を読む」
 * パターンのため、モジュールをリセットせずとも vi.stubEnv だけで検証できる
 * （tests/unit/db-flags.test.ts 相当のテストがあればそれと同じ構成のはずだが、
 * このモジュールは新規追加のためテストも新規作成する）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { getDbTarget } from '@/lib/db/target'

describe('getDbTarget (#693)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('DB_TARGET が未設定なら supabase を返す', () => {
    vi.stubEnv('DB_TARGET', undefined)
    expect(getDbTarget()).toBe('supabase')
  })

  it("DB_TARGET='planetscale' なら planetscale を返す", () => {
    vi.stubEnv('DB_TARGET', 'planetscale')
    expect(getDbTarget()).toBe('planetscale')
  })

  it("DB_TARGET='supabase' なら supabase を返す", () => {
    vi.stubEnv('DB_TARGET', 'supabase')
    expect(getDbTarget()).toBe('supabase')
  })

  it('不正な値（未知の文字列）は安全側の supabase にフォールバックする', () => {
    vi.stubEnv('DB_TARGET', 'typo-value')
    expect(getDbTarget()).toBe('supabase')
  })

  it('空文字列は未設定と同様に supabase にフォールバックする', () => {
    vi.stubEnv('DB_TARGET', '')
    expect(getDbTarget()).toBe('supabase')
  })

  it('前後の空白・改行を trim してから判定する（末尾改行混入で不正値扱いにならない）', () => {
    vi.stubEnv('DB_TARGET', 'planetscale\n')
    expect(getDbTarget()).toBe('planetscale')

    vi.stubEnv('DB_TARGET', '  supabase  ')
    expect(getDbTarget()).toBe('supabase')
  })

  it('大文字小文字は区別する（PlanetScale ではなく planetscale のみ有効値）', () => {
    vi.stubEnv('DB_TARGET', 'PlanetScale')
    expect(getDbTarget()).toBe('supabase')
  })
})
