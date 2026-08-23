import { describe, expect, it } from 'vitest'

import { ALLOWLIST } from '../../scripts/db-cutover/cutover-allowlist.mjs'
import {
  INVARIANTS,
  TIER_A,
  TIER_B,
  buildViolationCountSql,
  buildViolationDigestSql,
  buildViolationSampleSql,
} from '../../scripts/db-cutover/invariant-checks.mjs'

const VIOLATORS_CTE = `SELECT 'fixture'::text AS identifier`

describe('db cutover invariant checks', () => {
  it('違反件数・サンプル・digestのSQL契約を固定する', () => {
    expect(buildViolationCountSql(VIOLATORS_CTE)).toBe(
      `WITH violators AS (\n${VIOLATORS_CTE}\n)\nSELECT COUNT(*)::int AS count FROM violators`,
    )
    expect(buildViolationSampleSql(VIOLATORS_CTE)).toBe(
      `WITH violators AS (\n${VIOLATORS_CTE}\n)\nSELECT identifier FROM violators ORDER BY identifier COLLATE "C" LIMIT 10`,
    )
    expect(buildViolationDigestSql(VIOLATORS_CTE)).toBe(
      `WITH violators AS (\n${VIOLATORS_CTE}\n)\nSELECT md5(string_agg(identifier, ',' ORDER BY identifier COLLATE "C")) AS digest FROM violators`,
    )
  })

  it('Tier Aはdigestを持たず、Tier Bだけが決定的なdigest SQLを持つ', () => {
    const checks = INVARIANTS.flatMap((invariant) => invariant.checks)

    expect(checks.length).toBeGreaterThan(0)
    for (const check of checks) {
      if (check.tier === TIER_A) {
        expect(check.digestSql).toBeNull()
        continue
      }

      expect(check.tier).toBe(TIER_B)
      expect(check.digestSql).toContain(
        `ORDER BY identifier COLLATE "C"`,
      )
    }
  })

  it('report・allowlistの識別に使うinvariant idが重複しない', () => {
    const ids = INVARIANTS.map((invariant) => invariant.id)

    expect(new Set(ids).size).toBe(ids.length)
  })

  it('allowlistのinvariant参照が実在するinvariant idに一致する', () => {
    const invariantIds = new Set(INVARIANTS.map((invariant) => invariant.id))
    const allowlistedInvariantIds = ALLOWLIST.flatMap((entry) =>
      entry.appliesTo.flatMap((target) =>
        target.layer === 'invariants' ? [target.invariantId] : [],
      ),
    )

    expect(allowlistedInvariantIds.length).toBeGreaterThan(0)
    for (const invariantId of allowlistedInvariantIds) {
      expect(invariantIds.has(invariantId)).toBe(true)
    }
  })

  it('allowlist entryの追跡用codeが重複しない', () => {
    const codes = ALLOWLIST.map((entry) => entry.code)

    expect(new Set(codes).size).toBe(codes.length)
  })

  it('allowlistの適用先specが重複しない', () => {
    const specKeys = ALLOWLIST.flatMap((entry) =>
      entry.appliesTo.map((target) =>
        JSON.stringify(
          Object.entries(target).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
      ),
    )

    expect(new Set(specKeys).size).toBe(specKeys.length)
  })

  it('finding識別に使うcheck codeが重複しない', () => {
    const codes = INVARIANTS.flatMap((invariant) =>
      invariant.checks.map((check) => check.code),
    )

    expect(new Set(codes).size).toBe(codes.length)
  })
})
