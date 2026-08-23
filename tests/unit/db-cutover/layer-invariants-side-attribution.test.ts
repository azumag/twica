import { describe, expect, it } from 'vitest'

import { TIER_A } from '../../../scripts/db-cutover/invariant-checks.mjs'
import { evaluateInvariantsLayer } from '../../../scripts/db-cutover/layer-invariants.mjs'

const FIXTURE_INVARIANT = {
  id: 'fixture-side-attribution',
  description: 'fixture side attribution invariant',
  requiredTables: [],
  checks: [
    {
      code: 'FIXTURE_SIDE_CHECK',
      tier: TIER_A,
      countSql: 'COUNT_SQL',
      sampleSql: 'SAMPLE_SQL',
      digestSql: null,
    },
  ],
}

function sideResult(violationCount: number) {
  return {
    tablesOk: true,
    checks: [
      {
        code: 'FIXTURE_SIDE_CHECK',
        tier: TIER_A,
        violationCount,
        samples: violationCount > 0 ? ['violator'] : [],
        digest: null,
        durationMs: 1,
      },
    ],
    durationMs: 1,
  }
}

describe('db cutover invariant finding side attribution', () => {
  it.each([
    { sourceViolationCount: 1, targetViolationCount: 0, expectedSide: 'source' },
    { sourceViolationCount: 0, targetViolationCount: 1, expectedSide: 'target' },
  ])(
    '$expectedSide 側だけに違反がある場合、finding.side を取り違えない',
    ({ sourceViolationCount, targetViolationCount, expectedSide }) => {
      const source = sideResult(sourceViolationCount)
      const target = sideResult(targetViolationCount)

      expect(source).not.toBe(target)

      const result = evaluateInvariantsLayer({
        sourceResults: new Map([[FIXTURE_INVARIANT.id, source]]),
        targetResults: new Map([[FIXTURE_INVARIANT.id, target]]),
        invariantDefs: [FIXTURE_INVARIANT] as never,
      })

      expect(result.pass).toBe(false)
      expect(result.findings).toEqual([
        expect.objectContaining({
          severity: 'fail',
          code: 'FIXTURE_SIDE_CHECK',
          side: expectedSide,
        }),
      ])
      expect(result.invariants[0]).toMatchObject({
        id: FIXTURE_INVARIANT.id,
        pass: false,
        checks: [
          {
            code: 'FIXTURE_SIDE_CHECK',
            tier: TIER_A,
            pass: false,
            sideResults: {
              source: { violationCount: sourceViolationCount },
              target: { violationCount: targetViolationCount },
            },
          },
        ],
      })
    },
  )
})
