import { describe, expect, it } from 'vitest'
import {
  INVARIANTS,
  TIER_A,
  TIER_B,
  buildViolationCountSql,
  buildViolationSampleSql,
  buildViolationDigestSql,
} from '../../../scripts/db-cutover/invariant-checks.mjs'

/**
 * Issue #697 Chunk 3: invariant-checks.mjs（Layer 5 invariant定義）のテスト。
 *
 * SQL組み立て自体は純粋関数（buildViolationCountSql等）のため、正確なSQL文字列を
 * assertできる（layer-data.mjsのscanTable系テストと同じ流儀）。INVARIANTS配列は
 * モジュールロード時に1回だけ組み立てられる定数だが、各要素の構造的な整合性
 * （id重複無し・checksが1件以上・Tier Bのみdigest持ち等）を回帰的に検証する。
 */

describe('buildViolationCountSql / buildViolationSampleSql / buildViolationDigestSql', () => {
  const cte = `SELECT t.id::text AS identifier FROM t WHERE t.x IS NULL`

  it('countSqlはCTEをWITH句に埋め込みCOUNT(*)::intを返す', () => {
    const sql = buildViolationCountSql(cte)
    expect(sql).toContain('WITH violators AS (')
    expect(sql).toContain(cte)
    expect(sql).toContain('SELECT COUNT(*)::int AS count FROM violators')
  })

  it('sampleSqlはidentifier COLLATE "C"昇順でLIMIT 10', () => {
    const sql = buildViolationSampleSql(cte)
    expect(sql).toContain('SELECT identifier FROM violators ORDER BY identifier COLLATE "C" LIMIT 10')
  })

  it('digestSqlはmd5(string_agg(identifier, \',\' ORDER BY identifier COLLATE "C"))を計算する', () => {
    const sql = buildViolationDigestSql(cte)
    expect(sql).toContain('md5(string_agg(identifier, \',\' ORDER BY identifier COLLATE "C")) AS digest')
  })

  it('同じCTE本体を渡せば常に同じSQL文字列を返す（決定的、隠れた状態を持たない純粋関数であることの確認）', () => {
    const a = buildViolationCountSql(cte)
    const b = buildViolationCountSql(cte)
    expect(a).toBe(b)
  })
})

describe('INVARIANTS: 構造的な整合性', () => {
  it('12件のinvariantが定義されている（issue #697本文9項目 + card-stone-balance-recalc追加、設計書対応表どおり）', () => {
    expect(INVARIANTS).toHaveLength(12)
  })

  it('idは重複しない', () => {
    const ids = INVARIANTS.map((inv) => inv.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('全invariantが1件以上のcheckを持つ', () => {
    for (const inv of INVARIANTS) {
      expect(inv.checks.length).toBeGreaterThan(0)
    }
  })

  it('全invariantがrequiredTablesを1件以上持つ', () => {
    for (const inv of INVARIANTS) {
      expect(inv.requiredTables.length).toBeGreaterThan(0)
    }
  })

  it('全checkのcodeはUPPER_SNAKE_CASE形式（report上のfinding codeとして使われるため）', () => {
    for (const inv of INVARIANTS) {
      for (const check of inv.checks) {
        expect(check.code).toMatch(/^[A-Z][A-Z0-9_]*$/)
      }
    }
  })

  it('check codeはinvariant全体を通じて重複しない', () => {
    const codes = INVARIANTS.flatMap((inv) => inv.checks.map((c) => c.code))
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('Tier Aのcheckはtier="A"かつdigestSqlを持たない', () => {
    for (const inv of INVARIANTS) {
      for (const check of inv.checks) {
        if (check.tier === TIER_A) {
          expect(check.digestSql).toBeNull()
        }
      }
    }
  })

  it('Tier Bのcheckはtier="B"かつdigestSqlを持つ', () => {
    for (const inv of INVARIANTS) {
      for (const check of inv.checks) {
        if (check.tier === TIER_B) {
          expect(check.digestSql).not.toBeNull()
          expect(check.digestSql).toContain('md5(string_agg(')
        }
      }
    }
  })

  it('全checkのtierはAまたはBのいずれか', () => {
    for (const inv of INVARIANTS) {
      for (const check of inv.checks) {
        expect([TIER_A, TIER_B]).toContain(check.tier)
      }
    }
  })

  it('全checkのcountSql/sampleSqlはidentifier列を選択するSELECT文を含む', () => {
    for (const inv of INVARIANTS) {
      for (const check of inv.checks) {
        expect(check.countSql).toContain('AS identifier')
        expect(check.sampleSql).toContain('AS identifier')
      }
    }
  })
})

describe('個別invariantの設計対応（設計書「invariant一覧」表との対応確認）', () => {
  it('orphan-foreign-keysはFK 5経路すべてTier Aで持つ', () => {
    const inv = INVARIANTS.find((i) => i.id === 'orphan-foreign-keys')
    expect(inv).toBeDefined()
    expect(inv?.checks).toHaveLength(5)
    expect(inv?.checks.every((c) => c.tier === TIER_A)).toBe(true)
    expect(inv?.checks.map((c) => c.code)).toEqual([
      'ORPHAN_USER_CARDS_USER_ID',
      'ORPHAN_USER_CARDS_CARD_ID',
      'ORPHAN_CARDS_STREAMER_ID',
      'ORPHAN_GACHA_HISTORY_CARD_ID',
      'ORPHAN_GACHA_HISTORY_STREAMER_ID',
    ])
  })

  it('gacha-history-required-keysはTier A（必須列NULL）とTier B（event_id NULL）を1件ずつ持つ', () => {
    const inv = INVARIANTS.find((i) => i.id === 'gacha-history-required-keys')
    expect(inv?.checks.map((c) => [c.code, c.tier])).toEqual([
      ['GACHA_HISTORY_REQUIRED_COLUMN_NULL', TIER_A],
      ['GACHA_HISTORY_EVENT_ID_NULL', TIER_B],
    ])
  })

  it('nren-event-id-prefixは両方Tier B（正規の単一行削除で発生しうるため）', () => {
    const inv = INVARIANTS.find((i) => i.id === 'nren-event-id-prefix')
    expect(inv?.checks.every((c) => c.tier === TIER_B)).toBe(true)
    expect(inv?.checks.map((c) => c.code)).toEqual(['NREN_EVENT_ID_PREFIX_BASE_MISSING', 'NREN_EVENT_ID_PREFIX_GAP'])
  })

  it('card-issuance-over-limitはTier B（上限の事後引き下げが正規操作のため）', () => {
    const inv = INVARIANTS.find((i) => i.id === 'card-issuance-over-limit')
    expect(inv?.checks[0].tier).toBe(TIER_B)
  })

  it('support-code-license-stateはTier A', () => {
    const inv = INVARIANTS.find((i) => i.id === 'support-code-license-state')
    expect(inv?.checks[0].tier).toBe(TIER_A)
  })

  it('storage-usage-integrityはTier A（負値保険）1件 + Tier B（値突合）2件', () => {
    const inv = INVARIANTS.find((i) => i.id === 'storage-usage-integrity')
    const byTier = { A: inv?.checks.filter((c) => c.tier === TIER_A).length, B: inv?.checks.filter((c) => c.tier === TIER_B).length }
    expect(byTier).toEqual({ A: 1, B: 2 })
  })

  it('streamer-card-active-combinationはTier A', () => {
    const inv = INVARIANTS.find((i) => i.id === 'streamer-card-active-combination')
    expect(inv?.checks[0].tier).toBe(TIER_A)
  })

  it('card-owner-stats-recalcはTier Bのみ（孤児除外 + 値突合）', () => {
    const inv = INVARIANTS.find((i) => i.id === 'card-owner-stats-recalc')
    expect(inv?.checks.every((c) => c.tier === TIER_B)).toBe(true)
    expect(inv?.checks.map((c) => c.code)).toEqual(['CARD_OWNER_STATS_ORPHAN_USER', 'CARD_OWNER_STATS_VALUE_MISMATCH'])
  })

  it('battle-stats-consistencyはTier Aのみ（トリガーが差分演算型でlost updateしないため）、requiredTablesはbattles/battle_stats', () => {
    const inv = INVARIANTS.find((i) => i.id === 'battle-stats-consistency')
    expect(inv?.checks.every((c) => c.tier === TIER_A)).toBe(true)
    expect(inv?.requiredTables).toEqual(['battles', 'battle_stats'])
  })

  it('BATTLE_STATS_ROW_INCONSISTENTはtotal_battles IS NULLを独立条件として持つ（オーケストレーターレビュー Minor-1対応: total_battles/countersが両方NULLの行が他の3条件をすり抜ける偽陰性のPG17実測回帰防止）', () => {
    const inv = INVARIANTS.find((i) => i.id === 'battle-stats-consistency')
    const check = inv?.checks.find((c) => c.code === 'BATTLE_STATS_ROW_INCONSISTENT')
    expect(check?.countSql).toContain('WHERE bs.total_battles IS NULL')
  })

  it('card-stone-balance-recalcはTier A（差分演算型更新+消費経路無しで完全一致が保証される）', () => {
    const inv = INVARIANTS.find((i) => i.id === 'card-stone-balance-recalc')
    expect(inv?.checks[0].tier).toBe(TIER_A)
  })

  it('gacha-event-id-duplicatesはTier A（UNIQUE制約の保険）', () => {
    const inv = INVARIANTS.find((i) => i.id === 'gacha-event-id-duplicates')
    expect(inv?.checks[0].tier).toBe(TIER_A)
  })

  it('channel-point-usage-recalcはTier B（絶対値上書き型refreshでlost update raceがあるため）', () => {
    const inv = INVARIANTS.find((i) => i.id === 'channel-point-usage-recalc')
    expect(inv?.checks[0].tier).toBe(TIER_B)
  })
})
