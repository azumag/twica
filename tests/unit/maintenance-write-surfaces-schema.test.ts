import { describe, it, expect } from 'vitest'
import surfaces from '../../config/maintenance-write-surfaces.json'

/**
 * config/maintenance-write-surfaces.json のスキーマ検証 (#694 Stage 3)。
 *
 * このJSONは src/middleware.ts に静的importされ、allowlist判定
 * （src/lib/maintenance/allowlist.ts）に使われる。実行時に壊れた形の
 * エントリが紛れ込むと「allowlist登録し忘れ=安全側にブロック」という
 * fail-safe設計が壊れかねない（例: maintenanceBehaviorのtypoで
 * 'allow' のつもりが免除されない、pathのtypoで意図しないルートを
 * 免除してしまう等）ため、CIで機械的に検証する。
 */

const VALID_BEHAVIORS = ['block', 'allow', 'redirect', 'queue-during-maintenance']
const REQUIRED_STRING_FIELDS = [
  'path',
  'category',
  'maintenanceBehavior',
  'reason',
  'owner',
  'reviewedAt',
] as const

describe('config/maintenance-write-surfaces.json スキーマ', () => {
  it('配列であり、1件以上のエントリを持つ', () => {
    expect(Array.isArray(surfaces)).toBe(true)
    expect(surfaces.length).toBeGreaterThan(0)
  })

  it.each(surfaces as Array<Record<string, unknown>>)(
    '各エントリは必須フィールドを全て持つ: %j',
    (surface) => {
      for (const field of REQUIRED_STRING_FIELDS) {
        expect(surface).toHaveProperty(field)
        expect(typeof surface[field]).toBe('string')
        expect((surface[field] as string).length).toBeGreaterThan(0)
      }
      expect(Array.isArray(surface.methods)).toBe(true)
      expect((surface.methods as unknown[]).length).toBeGreaterThan(0)
    }
  )

  it.each(surfaces as Array<Record<string, unknown>>)(
    'maintenanceBehaviorは4値のいずれか: %j',
    (surface) => {
      expect(VALID_BEHAVIORS).toContain(surface.maintenanceBehavior)
    }
  )

  it.each(surfaces as Array<Record<string, unknown>>)(
    'pathは"/api/"始まり: %j',
    (surface) => {
      expect((surface.path as string).startsWith('/api/')).toBe(true)
    }
  )

  it.each(surfaces as Array<Record<string, unknown>>)(
    'methodsは全てHTTPメソッド文字列（大文字）: %j',
    (surface) => {
      const validMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
      for (const method of surface.methods as unknown[]) {
        expect(typeof method).toBe('string')
        expect(validMethods).toContain(method)
      }
    }
  )

  it('reviewedAtは全エントリでDate.parse可能な文字列', () => {
    for (const surface of surfaces as Array<Record<string, unknown>>) {
      expect(Number.isNaN(Date.parse(surface.reviewedAt as string))).toBe(false)
    }
  })

  it("maintenanceBehavior: 'redirect' のエントリは全てmethodsが['GET']（middlewareの一律ブロック対象外を明示）", () => {
    const redirectEntries = (surfaces as Array<Record<string, unknown>>).filter(
      (s) => s.maintenanceBehavior === 'redirect'
    )
    expect(redirectEntries.length).toBeGreaterThan(0)
    for (const entry of redirectEntries) {
      expect(entry.methods).toEqual(['GET'])
    }
  })

  it("maintenanceBehavior: 'block' のエントリはGETを含まない（GETのみのルートは棚卸し対象外というルールの確認）", () => {
    const blockEntries = (surfaces as Array<Record<string, unknown>>).filter(
      (s) => s.maintenanceBehavior === 'block'
    )
    for (const entry of blockEntries) {
      expect(entry.methods).not.toContain('GET')
    }
  })

  it('path + method の組み合わせに重複が無い', () => {
    const seen = new Set<string>()
    for (const surface of surfaces as Array<{ path: string; methods: string[] }>) {
      for (const method of surface.methods) {
        const key = `${method} ${surface.path}`
        expect(seen.has(key)).toBe(false)
        seen.add(key)
      }
    }
  })

  it("免除対象(allow/queue-during-maintenance)のpathは'/'で終わらない（末尾スラッシュはprefix一致に化け、免除範囲が意図せず広がるため）", () => {
    for (const surface of surfaces as Array<{ path: string; maintenanceBehavior: string }>) {
      if (
        surface.maintenanceBehavior === 'allow' ||
        surface.maintenanceBehavior === 'queue-during-maintenance'
      ) {
        expect(surface.path.endsWith('/')).toBe(false)
      }
    }
  })
})
