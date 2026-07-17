import { describe, it, expect } from 'vitest'
import {
  matchesSurfacePath,
  isMaintenanceWriteExempt,
  type MaintenanceWriteSurface,
} from '@/lib/maintenance/allowlist'

/**
 * src/lib/maintenance/allowlist.ts のパスマッチ純関数のテスト (#694 Stage 3)。
 *
 * config/maintenance-write-surfaces.json の実データには依存せず、fixture の
 * surfaces 配列だけを使う（allowlist.ts のコメントで説明している「実データに
 * 依存しない単体テスト」の方針どおり）。
 */
describe('matchesSurfacePath', () => {
  it('トレーリングスラッシュが無いパターンは完全一致のみ真になる', () => {
    expect(matchesSurfacePath('/api/auth/logout', '/api/auth/logout')).toBe(true)
    expect(matchesSurfacePath('/api/auth/logout/', '/api/auth/logout')).toBe(false)
    expect(matchesSurfacePath('/api/auth/logout2', '/api/auth/logout')).toBe(false)
  })

  it('完全一致パターンは「別ルートへの誤った前方一致」を起こさない（回帰テスト）', () => {
    // /api/twitch/eventsub (queue-during-maintenance) が
    // /api/twitch/eventsub/subscribe (block) まで誤って免除しないことを保証する。
    expect(
      matchesSurfacePath('/api/twitch/eventsub/subscribe', '/api/twitch/eventsub')
    ).toBe(false)
  })

  it('トレーリングスラッシュ付きパターンはプレフィックス一致になる', () => {
    expect(matchesSurfacePath('/api/cards/abc123', '/api/cards/')).toBe(true)
    expect(matchesSurfacePath('/api/cards/', '/api/cards/')).toBe(true)
    expect(matchesSurfacePath('/api/cards', '/api/cards/')).toBe(false)
  })

  it('プレフィックス一致パターンでも別の兄弟ルートへは一致しない', () => {
    // "/api/cards/" が "/api/cards-other" のような別ルートまで拾わないこと
    expect(matchesSurfacePath('/api/cards-other', '/api/cards/')).toBe(false)
  })

  it('非該当パスは false', () => {
    expect(matchesSurfacePath('/api/gacha', '/api/cards')).toBe(false)
  })
})

describe('isMaintenanceWriteExempt', () => {
  const surfaces: MaintenanceWriteSurface[] = [
    { path: '/api/auth/logout', methods: ['POST'], maintenanceBehavior: 'allow' },
    { path: '/api/twitch/eventsub', methods: ['POST'], maintenanceBehavior: 'queue-during-maintenance' },
    { path: '/api/cards', methods: ['POST'], maintenanceBehavior: 'block' },
    { path: '/api/auth/twitch/login', methods: ['GET'], maintenanceBehavior: 'redirect' },
    { path: '/api/cards/', methods: ['PUT', 'DELETE'], maintenanceBehavior: 'block' },
  ]

  it("maintenanceBehavior: 'allow' はメソッド一致なら免除される", () => {
    expect(isMaintenanceWriteExempt('/api/auth/logout', 'POST', surfaces)).toBe(true)
  })

  it("maintenanceBehavior: 'queue-during-maintenance' も免除される", () => {
    expect(isMaintenanceWriteExempt('/api/twitch/eventsub', 'POST', surfaces)).toBe(true)
  })

  it("maintenanceBehavior: 'block' は免除されない", () => {
    expect(isMaintenanceWriteExempt('/api/cards', 'POST', surfaces)).toBe(false)
  })

  it("maintenanceBehavior: 'redirect' はこの関数では免除扱いにならない（GET専用の別経路のため）", () => {
    expect(isMaintenanceWriteExempt('/api/auth/twitch/login', 'GET', surfaces)).toBe(false)
  })

  it('パスが一致してもメソッドが一致しなければ免除されない', () => {
    expect(isMaintenanceWriteExempt('/api/auth/logout', 'DELETE', surfaces)).toBe(false)
  })

  it('メソッドが一致してもパスが一致しなければ免除されない', () => {
    expect(isMaintenanceWriteExempt('/api/unknown-route', 'POST', surfaces)).toBe(false)
  })

  it('surfaces が空配列なら常に false', () => {
    expect(isMaintenanceWriteExempt('/api/auth/logout', 'POST', [])).toBe(false)
  })

  it('methods 配列内の一部のメソッドだけが免除される', () => {
    const partialMethodSurfaces: MaintenanceWriteSurface[] = [
      { path: '/api/cards/', methods: ['PUT', 'DELETE'], maintenanceBehavior: 'allow' },
    ]
    expect(isMaintenanceWriteExempt('/api/cards/abc', 'PUT', partialMethodSurfaces)).toBe(true)
    expect(isMaintenanceWriteExempt('/api/cards/abc', 'PATCH', partialMethodSurfaces)).toBe(false)
  })
})
