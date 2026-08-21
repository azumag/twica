import { describe, expect, it } from 'vitest'

import { INVARIANTS } from '../../scripts/db-cutover/invariant-checks.mjs'

const COUNT_SQL_PREFIX = 'WITH violators AS (\n'
const COUNT_SQL_SUFFIX = '\n)\nSELECT COUNT(*)::int AS count FROM violators'

function extractViolatorsCte(countSql: string): string {
  if (!countSql.startsWith(COUNT_SQL_PREFIX) || !countSql.endsWith(COUNT_SQL_SUFFIX)) {
    throw new Error('unexpected invariant count SQL shape')
  }

  return countSql.slice(COUNT_SQL_PREFIX.length, -COUNT_SQL_SUFFIX.length)
}

describe('db cutover invariant identifier contract', () => {
  it('各checkのviolators CTEがidentifier列をちょうど1つ定義する', () => {
    const invalidChecks = INVARIANTS.flatMap((invariant) =>
      invariant.checks.flatMap((check) => {
        const violatorsCte = extractViolatorsCte(check.countSql)
        const identifierAliases = violatorsCte.match(/\bAS identifier\b/g) ?? []

        return identifierAliases.length === 1
          ? []
          : [`${invariant.id}/${check.code}`]
      }),
    )

    expect(invalidChecks).toEqual([])
  })
})
