import { describe, expect, it, vi } from 'vitest'

import {
  INVARIANTS,
  TIER_A,
  TIER_B,
} from '../../../scripts/db-cutover/invariant-checks.mjs'
import {
  evaluateInvariantsLayer,
  readSideInvariants,
} from '../../../scripts/db-cutover/layer-invariants.mjs'

const FIXTURE_INVARIANT = {
  id: 'fixture-invariant',
  description: 'fixture invariant',
  requiredTables: [],
  checks: [
    {
      code: 'FIXTURE_CHECK',
      tier: TIER_A,
      countSql: 'COUNT_SQL',
      sampleSql: 'SAMPLE_SQL',
      digestSql: null,
    },
  ],
}

describe('db cutover layer invariants', () => {
  it('invariant id が重複しない', () => {
    const ids = INVARIANTS.map((invariant) => invariant.id)

    expect(new Set(ids).size).toBe(ids.length)
  })

  it('違反0件なら sample / digest SQL を実行せず side 結果を返す', async () => {
    const unsafe = vi.fn(async (sql: string) => {
      if (sql === 'COUNT_SQL') return [{ count: 0 }]
      throw new Error(`unexpected SQL: ${sql}`)
    })
    const onInvariantChecked = vi.fn()

    const results = await readSideInvariants(
      { unsafe } as never,
      [FIXTURE_INVARIANT] as never,
      'source',
      (text: string) => text,
      onInvariantChecked,
    )

    expect(unsafe).toHaveBeenCalledTimes(1)
    expect(unsafe).toHaveBeenCalledWith('COUNT_SQL')
    expect(results.get(FIXTURE_INVARIANT.id)).toEqual(
      expect.objectContaining({
        tablesOk: true,
        checks: [
          expect.objectContaining({
            code: 'FIXTURE_CHECK',
            violationCount: 0,
            samples: [],
            digest: null,
          }),
        ],
      }),
    )
    expect(onInvariantChecked).toHaveBeenCalledWith(
      expect.objectContaining({
        side: 'source',
        invariantId: FIXTURE_INVARIANT.id,
        tablesOk: true,
      }),
    )
  })

  it('Tier B でも違反0件なら digest SQL を実行しない', async () => {
    const tierBInvariant = {
      ...FIXTURE_INVARIANT,
      id: 'fixture-tier-b-invariant',
      checks: [
        {
          ...FIXTURE_INVARIANT.checks[0],
          tier: TIER_B,
          digestSql: 'DIGEST_SQL',
        },
      ],
    }
    const unsafe = vi.fn(async (sql: string) => {
      if (sql === 'COUNT_SQL') return [{ count: 0 }]
      throw new Error(`unexpected SQL: ${sql}`)
    })

    const results = await readSideInvariants(
      { unsafe } as never,
      [tierBInvariant] as never,
      'target',
      (text: string) => text,
      undefined,
    )

    expect(unsafe).toHaveBeenCalledTimes(1)
    expect(unsafe).toHaveBeenCalledWith('COUNT_SQL')
    expect(results.get(tierBInvariant.id)).toEqual(
      expect.objectContaining({
        tablesOk: true,
        checks: [
          expect.objectContaining({
            tier: TIER_B,
            violationCount: 0,
            samples: [],
            digest: null,
          }),
        ],
      }),
    )
  })

  it('Tier A が両側0件なら layer を pass にする', () => {
    const sideResult = {
      tablesOk: true,
      checks: [
        {
          code: 'FIXTURE_CHECK',
          tier: TIER_A,
          violationCount: 0,
          samples: [],
          digest: null,
          durationMs: 1,
        },
      ],
      durationMs: 1,
    }

    const result = evaluateInvariantsLayer({
      sourceResults: new Map([[FIXTURE_INVARIANT.id, sideResult]]),
      targetResults: new Map([[FIXTURE_INVARIANT.id, sideResult]]),
      invariantDefs: [FIXTURE_INVARIANT] as never,
    })

    expect(result).toMatchObject({
      layer: 'invariants',
      pass: true,
      findings: [],
      invariants: [
        {
          id: FIXTURE_INVARIANT.id,
          pass: true,
          allowlisted: false,
        },
      ],
    })
  })
})
