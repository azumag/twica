import { describe, expect, it } from 'vitest'
import {
  parseArgs,
  resolveConfig,
  resolveAppliedBy,
  hasBlockingErrors,
  shouldBlockFreshApply,
  FRESH_APPLY_PENDING_THRESHOLD,
} from '../../scripts/db-migrate.js'

/**
 * scripts/db-migrate.js の純粋関数（parseArgs/resolveConfig/resolveAppliedBy/hasBlockingErrors/
 * shouldBlockFreshApply）に対する単体テスト（Issue #692）。DB接続を伴う
 * cmdStatus/cmdPlan/cmdApply/cmdVerify/main はここでは対象外（Docker統合テストで検証する）。
 */

describe('parseArgs', () => {
  it('引数無しでは全てデフォルト値', () => {
    expect(parseArgs(['node', 'db-migrate.js'])).toEqual({
      help: false,
      command: undefined,
      bootstrap: false,
      confirmFreshApply: false,
      provider: undefined,
      unknownArgs: [],
    })
  })

  it('コマンド名を検出する', () => {
    expect(parseArgs(['node', 'db-migrate.js', 'status']).command).toBe('status')
    expect(parseArgs(['node', 'db-migrate.js', 'apply']).command).toBe('apply')
  })

  it('--bootstrap / --confirm-fresh-apply / --help / -h を検出する', () => {
    expect(parseArgs(['node', 'db-migrate.js', 'apply', '--bootstrap']).bootstrap).toBe(true)
    expect(parseArgs(['node', 'db-migrate.js', 'apply', '--confirm-fresh-apply']).confirmFreshApply).toBe(
      true
    )
    expect(parseArgs(['node', 'db-migrate.js', '--help']).help).toBe(true)
    expect(parseArgs(['node', 'db-migrate.js', '-h']).help).toBe(true)
  })

  it('--provider= からproviderを取り出す', () => {
    expect(parseArgs(['node', 'db-migrate.js', 'status', '--provider=planetscale']).provider).toBe(
      'planetscale'
    )
  })

  // Issue #692 Fableレビュー High-2: 実測で確認された3件の事故シナリオ。
  // いずれも「黙って無視される」のではなく unknownArgs に検出されることを確認する。
  it('未知のフラグ（typo）を unknownArgs に検出する: apply --boostrap', () => {
    const result = parseArgs(['node', 'db-migrate.js', 'apply', '--boostrap'])
    expect(result.unknownArgs).toEqual(['--boostrap'])
    expect(result.bootstrap).toBe(false) // typoなので正規の --bootstrap としては検出されない
  })

  it('スペース区切りの --provider を unknownArgs に検出する: status --provider planetscale', () => {
    const result = parseArgs(['node', 'db-migrate.js', 'status', '--provider', 'planetscale'])
    expect(result.unknownArgs).toEqual(['--provider', 'planetscale'])
    expect(result.provider).toBeUndefined() // "=" が無いので provider としては取り出されない
  })

  it('2個目以降の余剰位置引数を unknownArgs に検出する: status garbage-arg', () => {
    const result = parseArgs(['node', 'db-migrate.js', 'status', 'garbage-arg'])
    expect(result.command).toBe('status')
    expect(result.unknownArgs).toEqual(['garbage-arg'])
  })
})

describe('resolveConfig', () => {
  const env = { DATABASE_URL: 'postgres://user:pass@localhost:5432/db' }

  it('--help はhelp:trueを返す（他の検証より優先）', () => {
    expect(resolveConfig(['node', 'db-migrate.js', '--help'], {})).toEqual({ help: true })
  })

  it('コマンド未指定はエラー', () => {
    const result = resolveConfig(['node', 'db-migrate.js'], env) as { error: string }
    expect(result.error).toContain('status/plan/apply/verify')
  })

  it('不正なコマンド名はエラー', () => {
    const result = resolveConfig(['node', 'db-migrate.js', 'destroy'], env) as { error: string }
    expect(result.error).toBeDefined()
  })

  it('--bootstrap は apply 以外につけるとエラー', () => {
    const result = resolveConfig(['node', 'db-migrate.js', 'status', '--bootstrap'], env) as { error: string }
    expect(result.error).toContain('--bootstrap')
  })

  it('--bootstrap は apply には付けられる', () => {
    const result = resolveConfig(['node', 'db-migrate.js', 'apply', '--bootstrap'], env) as {
      command: string
      bootstrap: boolean
    }
    expect(result.command).toBe('apply')
    expect(result.bootstrap).toBe(true)
  })

  it('--confirm-fresh-apply は apply 以外につけるとエラー', () => {
    const result = resolveConfig(['node', 'db-migrate.js', 'status', '--confirm-fresh-apply'], env) as {
      error: string
    }
    expect(result.error).toContain('--confirm-fresh-apply')
  })

  it('--confirm-fresh-apply は apply には付けられる', () => {
    const result = resolveConfig(['node', 'db-migrate.js', 'apply', '--confirm-fresh-apply'], env) as {
      command: string
      confirmFreshApply: boolean
    }
    expect(result.command).toBe('apply')
    expect(result.confirmFreshApply).toBe(true)
  })

  // Issue #692 Fableレビュー High-2: 実測で確認された3件の事故シナリオが、
  // resolveConfig の時点で明確なエラーとして終了することを確認する
  // （黙って通常のstatus/applyが実行されてしまわないこと）。
  it('未知のフラグ（typo）はエラーで終了する: apply --boostrap', () => {
    const result = resolveConfig(['node', 'db-migrate.js', 'apply', '--boostrap'], env) as { error: string }
    expect(result.error).toContain('--boostrap')
    expect(result.error).toContain('不明な引数')
  })

  it('スペース区切りの --provider はエラーで終了する: status --provider planetscale', () => {
    const result = resolveConfig(['node', 'db-migrate.js', 'status', '--provider', 'planetscale'], env) as {
      error: string
    }
    expect(result.error).toContain('不明な引数')
    expect(result.error).toContain('--provider')
  })

  it('余剰位置引数はエラーで終了する: status garbage-arg', () => {
    const result = resolveConfig(['node', 'db-migrate.js', 'status', 'garbage-arg'], env) as { error: string }
    expect(result.error).toContain('garbage-arg')
    expect(result.error).toContain('不明な引数')
  })

  it('provider省略時は supabase がデフォルト', () => {
    const result = resolveConfig(['node', 'db-migrate.js', 'status'], env) as { provider: string }
    expect(result.provider).toBe('supabase')
  })

  it('不正なproviderはエラー', () => {
    const result = resolveConfig(['node', 'db-migrate.js', 'status', '--provider=mysql'], env) as {
      error: string
    }
    expect(result.error).toContain('mysql')
  })

  // Issue #692 Fableレビュー 最終回・軽微指摘: `--provider=`（値が空文字列）は、フラグ自体が
  // 省略された場合と違い、CI等でシェル変数展開が空になった結果である可能性がある。
  // 黙って supabase にフォールバックせず、明示的なエラーとして検知する。
  it('--provider=（空値）はエラーで終了する（黙って supabase にフォールバックしない）', () => {
    const result = resolveConfig(['node', 'db-migrate.js', 'status', '--provider='], env) as {
      error: string
    }
    expect(result.error).toContain('--provider')
  })

  it('DATABASE_URL が未設定だとエラー（CLI引数では受け付けない）', () => {
    const result = resolveConfig(['node', 'db-migrate.js', 'status'], {}) as { error: string }
    expect(result.error).toContain('DATABASE_URL')
  })

  it('正常系: command/provider/databaseUrl/bootstrap/confirmFreshApplyを解決する', () => {
    const result = resolveConfig(['node', 'db-migrate.js', 'plan', '--provider=postgres'], env) as {
      command: string
      provider: string
      databaseUrl: string
      bootstrap: boolean
      confirmFreshApply: boolean
    }
    expect(result).toEqual({
      command: 'plan',
      bootstrap: false,
      confirmFreshApply: false,
      provider: 'postgres',
      databaseUrl: env.DATABASE_URL,
    })
  })
})

describe('resolveAppliedBy', () => {
  it('MIGRATION_APPLIED_BY が設定されていればそれを使う', () => {
    expect(resolveAppliedBy({ MIGRATION_APPLIED_BY: 'ci-runner' })).toBe('ci-runner')
  })

  it('MIGRATION_APPLIED_BY が空文字/未設定ならOSユーザー名（またはunknown）にフォールバックする', () => {
    const result = resolveAppliedBy({})
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })
})

describe('hasBlockingErrors', () => {
  const emptyState = {
    duplicateVersions: [],
    descriptorErrors: [],
    checksumMismatches: [],
    missingFiles: [],
  }

  it('全て空なら false', () => {
    expect(hasBlockingErrors(emptyState)).toBe(false)
  })

  it('duplicateVersions があれば true', () => {
    expect(hasBlockingErrors({ ...emptyState, duplicateVersions: [{ version: '1', filenames: [] }] })).toBe(
      true
    )
  })

  it('checksumMismatches があれば true', () => {
    expect(
      hasBlockingErrors({
        ...emptyState,
        checksumMismatches: [{ version: '1', name: 'a', diskChecksum: 'x', historyChecksum: 'y' }],
      })
    ).toBe(true)
  })

  it('missingFiles があれば true', () => {
    expect(hasBlockingErrors({ ...emptyState, missingFiles: [{ version: '1', name: 'a' }] })).toBe(true)
  })

  it('descriptorErrors があれば true', () => {
    expect(
      hasBlockingErrors({ ...emptyState, descriptorErrors: [{ filename: 'a.sql', errors: ['bad'] }] })
    ).toBe(true)
  })
})

/**
 * Issue #692 Fableレビュー Medium-1: 「history table不存在（真っ新なDB）+ pending大量 +
 * --bootstrap無し」のシナリオで、確認フラグ (--confirm-fresh-apply) 無しならブロック（true）、
 * フラグありなら実行を許可（false）することを確認する。
 * cmdApply 自体はDB接続が必要なため、実際の分岐判断を担う純粋関数 shouldBlockFreshApply を
 * 直接テストすることで、DBモックを用意せずに同じ分岐ロジックを検証する
 * （DB接続を伴う統合的な確認はDocker Postgresで別途実施する）。
 */
describe('shouldBlockFreshApply', () => {
  const freshDbManyPending = {
    bootstrap: false,
    historyTableExistedBefore: false,
    pendingCount: FRESH_APPLY_PENDING_THRESHOLD, // 閾値ちょうど
    confirmFreshApply: false,
  }

  it('真っ新DB + pending大量 + bootstrap無し + confirmFreshApply無し はブロックする (true)', () => {
    expect(shouldBlockFreshApply(freshDbManyPending)).toBe(true)
  })

  it('同シナリオで --confirm-fresh-apply があれば実行を許可する (false)', () => {
    expect(shouldBlockFreshApply({ ...freshDbManyPending, confirmFreshApply: true })).toBe(false)
  })

  it('--bootstrap があればconfirmFreshApply無しでもブロックしない (false)', () => {
    expect(shouldBlockFreshApply({ ...freshDbManyPending, bootstrap: true })).toBe(false)
  })

  it('history table が既に存在すればブロックしない (false)', () => {
    expect(shouldBlockFreshApply({ ...freshDbManyPending, historyTableExistedBefore: true })).toBe(false)
  })

  it('pending件数が閾値未満ならブロックしない (false)', () => {
    expect(
      shouldBlockFreshApply({ ...freshDbManyPending, pendingCount: FRESH_APPLY_PENDING_THRESHOLD - 1 })
    ).toBe(false)
  })
})
