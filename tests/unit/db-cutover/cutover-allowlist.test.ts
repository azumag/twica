import { describe, expect, it } from 'vitest'
import { ALLOWLIST, findAllowlistEntry } from '../../../scripts/db-cutover/cutover-allowlist.mjs'

/**
 * Issue #697 Chunk 3: cutover-allowlist.mjs（レイヤー横断allowlist）のテスト。
 * findAllowlistEntryはDB接続を持たない純粋関数のため、fixtureの条件をそのまま渡してテストできる。
 */

describe('ALLOWLIST', () => {
  it('初期内容は1件（battles/battle_stats不存在、#625）', () => {
    expect(ALLOWLIST).toHaveLength(1)
  })

  it('全エントリがreason/referenceを空でなく持つ（無視理由を必ずreportできるようにするため）', () => {
    for (const entry of ALLOWLIST) {
      expect(entry.reason.length).toBeGreaterThan(0)
      expect(entry.reference.length).toBeGreaterThan(0)
    }
  })
})

describe('findAllowlistEntry', () => {
  it('data layerのbattlesテーブルに一致する', () => {
    const entry = findAllowlistEntry({ layer: 'data', table: 'battles' })
    expect(entry).not.toBeNull()
    expect(entry?.code).toBe('BATTLE_FEATURE_TABLES_ABSENT_IN_PROD')
  })

  it('data layerのbattle_statsテーブルに一致する', () => {
    const entry = findAllowlistEntry({ layer: 'data', table: 'battle_stats' })
    expect(entry).not.toBeNull()
  })

  it('invariants layerのbattle-stats-consistency invariantIdに一致する', () => {
    const entry = findAllowlistEntry({ layer: 'invariants', invariantId: 'battle-stats-consistency' })
    expect(entry).not.toBeNull()
    expect(entry?.code).toBe('BATTLE_FEATURE_TABLES_ABSENT_IN_PROD')
  })

  it('未登録のテーブル名には一致しない（null）', () => {
    expect(findAllowlistEntry({ layer: 'data', table: 'cards' })).toBeNull()
  })

  it('未登録のinvariantIdには一致しない（null）', () => {
    expect(findAllowlistEntry({ layer: 'invariants', invariantId: 'orphan-foreign-keys' })).toBeNull()
  })

  it('layerが一致しなければtable/invariantIdが同名でも一致しない', () => {
    // battlesはdata layer用エントリのみなので、invariants layerでの照合には一致しない
    expect(findAllowlistEntry({ layer: 'invariants', invariantId: 'battles' })).toBeNull()
  })
})
