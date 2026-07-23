import { describe, expect, it } from 'vitest'
import { parseInitIdentityArgs, resolveInitIdentityConfig } from '../../../scripts/db-cutover/init-identity.mjs'

const ENV = { DATABASE_URL: 'postgres://u:p@host:5432/db' }

describe('parseInitIdentityArgs', () => {
  it('--environment/--provider/--forceを解析する', () => {
    const parsed = parseInitIdentityArgs(['node', 'init-identity.mjs', '--environment=production', '--provider=planetscale', '--force'])
    expect(parsed).toMatchObject({ help: false, force: true, environment: 'production', provider: 'planetscale', unknownArgs: [] })
  })

  it('--forceを指定しなければforce=false', () => {
    const parsed = parseInitIdentityArgs(['node', 'init-identity.mjs', '--environment=preview', '--provider=supabase'])
    expect(parsed.force).toBe(false)
  })

  it('未知のフラグはunknownArgsに積む', () => {
    const parsed = parseInitIdentityArgs(['node', 'init-identity.mjs', '--environment=preview', '--provider=supabase', '--typo'])
    expect(parsed.unknownArgs).toEqual(['--typo'])
  })
})

describe('resolveInitIdentityConfig', () => {
  it('必須引数が揃っていれば設定オブジェクトを返す', () => {
    const resolved = resolveInitIdentityConfig(
      ['node', 'init-identity.mjs', '--environment=production', '--provider=planetscale'],
      ENV
    )
    expect(resolved).toEqual({
      environment: 'production',
      provider: 'planetscale',
      force: false,
      databaseUrl: ENV.DATABASE_URL,
    })
  })

  it('--environment省略はエラー（デフォルト推測しない）', () => {
    const resolved = resolveInitIdentityConfig(['node', 'init-identity.mjs', '--provider=planetscale'], ENV)
    expect(resolved.error).toMatch(/--environment/)
  })

  it('--provider省略はエラー（デフォルト推測しない）', () => {
    const resolved = resolveInitIdentityConfig(['node', 'init-identity.mjs', '--environment=production'], ENV)
    expect(resolved.error).toMatch(/--provider/)
  })

  it('不正なenvironment値はエラー', () => {
    const resolved = resolveInitIdentityConfig(
      ['node', 'init-identity.mjs', '--environment=staging', '--provider=planetscale'],
      ENV
    )
    expect(resolved.error).toMatch(/production\/preview/)
  })

  it('不正なprovider値はエラー', () => {
    const resolved = resolveInitIdentityConfig(
      ['node', 'init-identity.mjs', '--environment=production', '--provider=aws-rds'],
      ENV
    )
    expect(resolved.error).toMatch(/supabase\/planetscale/)
  })

  it('DATABASE_URL未設定はエラー', () => {
    const resolved = resolveInitIdentityConfig(['node', 'init-identity.mjs', '--environment=production', '--provider=planetscale'], {})
    expect(resolved.error).toMatch(/DATABASE_URL/)
  })

  it('--helpならhelp:trueのみを返す', () => {
    expect(resolveInitIdentityConfig(['node', 'init-identity.mjs', '--help'], ENV)).toEqual({ help: true })
  })

  it('未知のフラグがあればエラー', () => {
    const resolved = resolveInitIdentityConfig(
      ['node', 'init-identity.mjs', '--environment=production', '--provider=planetscale', '--bogus'],
      ENV
    )
    expect(resolved.error).toMatch(/不明な引数/)
  })

  it('--database-urlというCLIフラグは実装されていない（未知の引数として拒否される）', () => {
    // Issue #697本文が案として示した --database-url=<env var名 or 直接値> は、既存の
    // DATABASE_URL環境変数専用方針（db-migrate.js等）との一貫性のため実装しない設計判断
    // （init-identity.mjs冒頭コメント参照）。
    const resolved = resolveInitIdentityConfig(
      ['node', 'init-identity.mjs', '--environment=production', '--provider=planetscale', '--database-url=postgres://x'],
      ENV
    )
    expect(resolved.error).toMatch(/不明な引数/)
  })

  it('同一フラグの重複指定はエラー（オーケストレーターレビュー Minor-7対応、黙って後勝ちにしない）', () => {
    const resolved = resolveInitIdentityConfig(
      ['node', 'init-identity.mjs', '--environment=production', '--provider=planetscale', '--environment=preview'],
      ENV
    )
    expect(resolved.error).toMatch(/重複/)
  })
})
