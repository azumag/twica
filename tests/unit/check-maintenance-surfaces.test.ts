import { describe, expect, it } from 'vitest'
import {
  deriveRoutePath,
  extractRouteWriteExports,
  diffRouteInventory,
  validateSchema,
  collectStaleReviewWarnings,
} from '../../scripts/check-maintenance-surfaces.js'

describe('deriveRoutePath', () => {
  it('動的セグメントを含むroute.tsをURLパスへ変換する', () => {
    expect(deriveRoutePath('src/app/api/cards/[id]/route.ts')).toBe('/api/cards/[id]')
  })

  it('動的セグメントの無いroute.tsをURLパスへ変換する', () => {
    expect(deriveRoutePath('src/app/api/cards/route.ts')).toBe('/api/cards')
  })

  it('ネストしたルートを変換する', () => {
    expect(deriveRoutePath('src/app/api/support-inquiries/[id]/messages/route.ts')).toBe(
      '/api/support-inquiries/[id]/messages'
    )
  })

  it('OSのパス区切り文字 (バックスラッシュ) にも対応する', () => {
    expect(deriveRoutePath('src\\app\\api\\cards\\route.ts')).toBe('/api/cards')
  })

  it('src/app/api配下でないパスはエラーを投げる', () => {
    expect(() => deriveRoutePath('src/app/page.tsx')).toThrow()
  })

  it('route.tsでないパスはエラーを投げる', () => {
    expect(() => deriveRoutePath('src/app/api/cards/page.tsx')).toThrow()
  })
})

describe('extractRouteWriteExports', () => {
  it('export async function POST 形式を検出する', () => {
    const result = extractRouteWriteExports(
      'export async function POST(req: Request) { return new Response() }',
      'route.ts'
    )
    expect(result.methods).toEqual(['POST'])
    expect(result.unresolved).toEqual([])
  })

  it('export const POST = ... 形式を検出する', () => {
    const result = extractRouteWriteExports(
      'export const POST = async (req: Request) => { return new Response() }',
      'route.ts'
    )
    expect(result.methods).toEqual(['POST'])
    expect(result.unresolved).toEqual([])
  })

  it('複数の書き込みメソッドを1ファイルから検出する (PUT + DELETE)', () => {
    const source = [
      'export async function PUT(req: Request) { return new Response() }',
      'export async function DELETE(req: Request) { return new Response() }',
    ].join('\n')
    const result = extractRouteWriteExports(source, 'route.ts')
    expect(result.methods).toEqual(['DELETE', 'PUT'])
  })

  it('GETはWRITE_METHODS対象外なので検出しない', () => {
    const result = extractRouteWriteExports(
      'export async function GET(req: Request) { return new Response() }',
      'route.ts'
    )
    expect(result.methods).toEqual([])
    expect(result.unresolved).toEqual([])
  })

  it('exportされていない関数は検出しない', () => {
    const result = extractRouteWriteExports(
      'async function POST(req: Request) { return new Response() }',
      'route.ts'
    )
    expect(result.methods).toEqual([])
  })

  it('ローカル宣言のre-export list (export { POST}、from節なし) は静的に解決して検出する', () => {
    const source = ['async function POST(req: Request) { return new Response() }', 'export { POST }'].join(
      '\n'
    )
    const result = extractRouteWriteExports(source, 'route.ts')
    expect(result.methods).toEqual(['POST'])
    expect(result.unresolved).toEqual([])
  })

  it('他モジュールからのre-export (export { POST } from) はfail-closedでunresolvedに積む', () => {
    const result = extractRouteWriteExports("export { POST } from './handlers'", 'route.ts')
    expect(result.methods).toEqual([])
    expect(result.unresolved).toEqual([
      { method: 'POST', reason: "'export { POST } from ...' は静的に解決できません" },
    ])
  })

  it('wildcard re-export (export * from) はfail-closedでunresolvedに積む', () => {
    const result = extractRouteWriteExports("export * from './handlers'", 'route.ts')
    expect(result.methods).toEqual([])
    expect(result.unresolved).toEqual([{ method: null, reason: "'export * from ...' は静的に解決できません" }])
  })

  it('re-exportでもGETなど書き込み対象外のメソッドはunresolvedに積まない', () => {
    const result = extractRouteWriteExports("export { GET } from './handlers'", 'route.ts')
    expect(result.methods).toEqual([])
    expect(result.unresolved).toEqual([])
  })

  it('type-only export は無視する', () => {
    const result = extractRouteWriteExports("export type { POST } from './types'", 'route.ts')
    expect(result.methods).toEqual([])
    expect(result.unresolved).toEqual([])
  })

  it('分割代入export (export const { POST } = handlers) を検出する (Fableレビュー指摘1)', () => {
    const result = extractRouteWriteExports('export const { POST } = handlers', 'route.ts')
    expect(result.methods).toEqual(['POST'])
    expect(result.unresolved).toEqual([])
  })

  it('プロパティ名リネームを伴う分割代入export (export const { post: POST } = handlers) を検出する', () => {
    const result = extractRouteWriteExports('export const { post: POST } = handlers', 'route.ts')
    expect(result.methods).toEqual(['POST'])
    expect(result.unresolved).toEqual([])
  })

  it('配列の分割代入export (export const [POST] = handlers) を検出する', () => {
    const result = extractRouteWriteExports('export const [POST] = handlers', 'route.ts')
    expect(result.methods).toEqual(['POST'])
    expect(result.unresolved).toEqual([])
  })

  it('複数の書き込みメソッドを1つの分割代入exportから検出する', () => {
    const result = extractRouteWriteExports('export const { POST, DELETE } = handlers', 'route.ts')
    expect(result.methods).toEqual(['DELETE', 'POST'])
    expect(result.unresolved).toEqual([])
  })

  it('default export (export default function POST(){}) は検出しない (Fableレビュー指摘3)', () => {
    const result = extractRouteWriteExports(
      'export default function POST(req: Request) { return new Response() }',
      'route.ts'
    )
    expect(result.methods).toEqual([])
    expect(result.unresolved).toEqual([])
  })
})

describe('diffRouteInventory', () => {
  it('実routeとinventoryが完全一致すればmissing/staleとも空', () => {
    const actual = [{ path: '/api/cards', methods: ['POST'] }]
    const inventory = [{ path: '/api/cards', methods: ['POST'] }]
    expect(diffRouteInventory(actual, inventory)).toEqual({ missing: [], stale: [] })
  })

  it('実routeにあるがinventoryに無い組み合わせをmissingとして検出する', () => {
    const actual = [{ path: '/api/cards', methods: ['POST'] }]
    const inventory: Array<{ path: string; methods: string[] }> = []
    expect(diffRouteInventory(actual, inventory)).toEqual({
      missing: ['POST /api/cards'],
      stale: [],
    })
  })

  it('inventoryにあるが実routeに無い組み合わせをstaleとして検出する', () => {
    const actual: Array<{ path: string; methods: string[] }> = []
    const inventory = [{ path: '/api/removed', methods: ['DELETE'] }]
    expect(diffRouteInventory(actual, inventory)).toEqual({
      missing: [],
      stale: ['DELETE /api/removed'],
    })
  })

  it('GETのみのinventoryエントリ (redirect behavior) はスコープ外として比較に含めない', () => {
    const actual: Array<{ path: string; methods: string[] }> = []
    const inventory = [{ path: '/api/auth/twitch/callback', methods: ['GET'] }]
    expect(diffRouteInventory(actual, inventory)).toEqual({ missing: [], stale: [] })
  })

  it('1つのrouteが複数methodをexportし、一部だけ登録漏れの場合を検出する', () => {
    const actual = [{ path: '/api/streamer/additional-rewards', methods: ['POST', 'DELETE'] }]
    const inventory = [{ path: '/api/streamer/additional-rewards', methods: ['POST'] }]
    expect(diffRouteInventory(actual, inventory)).toEqual({
      missing: ['DELETE /api/streamer/additional-rewards'],
      stale: [],
    })
  })
})

describe('validateSchema', () => {
  const validEntry = {
    path: '/api/cards',
    methods: ['POST'],
    category: 'cards',
    maintenanceBehavior: 'block',
    reason: 'テスト用',
    owner: 'azumag',
    reviewedAt: '2026-07-18',
  }

  it('validなエントリはエラー無し', () => {
    expect(validateSchema([validEntry])).toEqual([])
  })

  it('配列でない場合はエラー', () => {
    expect(validateSchema({} as unknown as unknown[]).length).toBeGreaterThan(0)
  })

  it('空配列はエラー', () => {
    expect(validateSchema([]).length).toBeGreaterThan(0)
  })

  it('必須フィールド欠落を検出する', () => {
    const { owner, ...missingOwner } = validEntry
    void owner
    const errors = validateSchema([missingOwner])
    expect(errors.some((e) => e.includes('owner'))).toBe(true)
  })

  it('maintenanceBehaviorの4値制約違反を検出する', () => {
    const errors = validateSchema([{ ...validEntry, maintenanceBehavior: 'typo-value' }])
    expect(errors.some((e) => e.includes('maintenanceBehavior'))).toBe(true)
  })

  it('methodsに不正なHTTPメソッド文字列があれば検出する', () => {
    const errors = validateSchema([{ ...validEntry, methods: ['FETCH'] }])
    expect(errors.some((e) => e.includes('methods'))).toBe(true)
  })

  it('pathが/api/始まりでない場合を検出する', () => {
    const errors = validateSchema([{ ...validEntry, path: '/cards' }])
    expect(errors.some((e) => e.includes('"/api/"'))).toBe(true)
  })

  it("allow/queue-during-maintenanceのpathが'/'で終わる場合を検出する", () => {
    const errors = validateSchema([
      { ...validEntry, path: '/api/cards/', maintenanceBehavior: 'allow' },
    ])
    expect(errors.some((e) => e.includes('末尾スラッシュ'))).toBe(true)
  })

  it("blockのpathが'/'で終わっても末尾スラッシュ検査の対象外 (免除対象のみが対象)", () => {
    const errors = validateSchema([{ ...validEntry, path: '/api/cards/', maintenanceBehavior: 'block' }])
    expect(errors.some((e) => e.includes('末尾スラッシュ'))).toBe(false)
  })

  it('path + method の重複を検出する', () => {
    const errors = validateSchema([validEntry, { ...validEntry }])
    expect(errors.some((e) => e.includes('重複'))).toBe(true)
  })

  it('reviewedAtがDate.parse不能な場合を検出する (Fableレビュー指摘2で欠落していたルール)', () => {
    const errors = validateSchema([{ ...validEntry, reviewedAt: 'not-a-date' }])
    expect(errors.some((e) => e.includes('reviewedAt'))).toBe(true)
  })

  it("redirectエントリのmethodsが['GET']以外の場合を検出する (Fableレビュー指摘2で欠落していたルール)", () => {
    const errors = validateSchema([
      { ...validEntry, maintenanceBehavior: 'redirect', methods: ['GET', 'POST'] },
    ])
    expect(errors.some((e) => e.includes("redirect"))).toBe(true)
  })

  it("redirectエントリのmethodsが['GET']のみなら合格する", () => {
    const errors = validateSchema([{ ...validEntry, maintenanceBehavior: 'redirect', methods: ['GET'] }])
    expect(errors).toEqual([])
  })

  it('blockエントリのmethodsにGETが含まれる場合を検出する (Fableレビュー指摘2で欠落していたルール)', () => {
    const errors = validateSchema([{ ...validEntry, maintenanceBehavior: 'block', methods: ['GET', 'POST'] }])
    expect(errors.some((e) => e.includes("block"))).toBe(true)
  })
})

describe('collectStaleReviewWarnings', () => {
  const now = Date.parse('2026-07-18T00:00:00Z')
  const DAY_MS = 24 * 60 * 60 * 1000

  it('reviewedAtが新しいallowエントリは警告なし', () => {
    const entries = [
      {
        path: '/api/auth/logout',
        maintenanceBehavior: 'allow',
        reviewedAt: new Date(now - 10 * DAY_MS).toISOString(),
      },
    ]
    expect(collectStaleReviewWarnings(entries, now)).toEqual([])
  })

  it('reviewedAtが180日超過したallowエントリは警告する', () => {
    const entries = [
      {
        path: '/api/auth/logout',
        maintenanceBehavior: 'allow',
        reviewedAt: new Date(now - 200 * DAY_MS).toISOString(),
      },
    ]
    const warnings = collectStaleReviewWarnings(entries, now)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('/api/auth/logout')
  })

  it('reviewedAtが180日超過したqueue-during-maintenanceエントリも警告する', () => {
    const entries = [
      {
        path: '/api/twitch/eventsub',
        maintenanceBehavior: 'queue-during-maintenance',
        reviewedAt: new Date(now - 300 * DAY_MS).toISOString(),
      },
    ]
    expect(collectStaleReviewWarnings(entries, now)).toHaveLength(1)
  })

  it('blockエントリは古くても警告しない (allow/queue-during-maintenanceのみ対象)', () => {
    const entries = [
      {
        path: '/api/cards',
        maintenanceBehavior: 'block',
        reviewedAt: new Date(now - 1000 * DAY_MS).toISOString(),
      },
    ]
    expect(collectStaleReviewWarnings(entries, now)).toEqual([])
  })

  it('reviewedAtがパース不能な値は警告をスキップする (スキーマ検証側の責務)', () => {
    const entries = [
      {
        path: '/api/cards',
        maintenanceBehavior: 'allow',
        reviewedAt: 'not-a-date',
      },
    ]
    expect(collectStaleReviewWarnings(entries, now)).toEqual([])
  })
})
