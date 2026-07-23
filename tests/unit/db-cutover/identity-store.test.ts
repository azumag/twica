import { describe, expect, it } from 'vitest'
import {
  IDENTITY_TABLE_SQL,
  VALID_IDENTITY_ENVIRONMENTS,
  VALID_IDENTITY_PROVIDERS,
  decideSeedAction,
} from '../../../scripts/db-cutover/identity-store.mjs'

describe('IDENTITY_TABLE_SQL', () => {
  it('twica_meta.database_identity を対象にした CREATE TABLE IF NOT EXISTS である', () => {
    expect(IDENTITY_TABLE_SQL).toContain('create table if not exists twica_meta.database_identity')
  })

  it('Issue #697本文が定義する4列（environment/provider/instance_id/initialized_at）を持つ', () => {
    expect(IDENTITY_TABLE_SQL).toContain('environment text primary key')
    expect(IDENTITY_TABLE_SQL).toContain('provider text not null')
    expect(IDENTITY_TABLE_SQL).toContain('instance_id uuid not null')
    expect(IDENTITY_TABLE_SQL).toContain('initialized_at timestamptz not null')
  })

  it('migrationファイル形式のヘッダー（-- migration-providers等）を含まない（ツール自己管理のため）', () => {
    expect(IDENTITY_TABLE_SQL).not.toMatch(/migration-providers|migration-transaction/)
  })
})

describe('VALID_IDENTITY_ENVIRONMENTS / VALID_IDENTITY_PROVIDERS', () => {
  it('environmentはproduction/previewの2値', () => {
    expect(VALID_IDENTITY_ENVIRONMENTS).toEqual(['production', 'preview'])
  })
  it('providerはsupabase/planetscaleの2値', () => {
    expect(VALID_IDENTITY_PROVIDERS).toEqual(['supabase', 'planetscale'])
  })
})

describe('decideSeedAction', () => {
  it('既存行が0件なら insert', () => {
    expect(decideSeedAction([], false)).toEqual({ action: 'insert' })
  })

  it('既存行が0件なら --force の有無に関わらず insert', () => {
    expect(decideSeedAction([], true)).toEqual({ action: 'insert' })
  })

  it('既存行が1件かつ --force 無しなら reject（既存行を含めて返す）', () => {
    const existing = [{ environment: 'preview', provider: 'supabase', instance_id: 'abc', initialized_at: new Date('2026-01-01') }]
    expect(decideSeedAction(existing, false)).toEqual({ action: 'reject', existingRows: existing })
  })

  it('既存行が1件かつ --force ありなら overwrite（既存のinstance_id/initialized_atを保持）', () => {
    const initializedAt = new Date('2026-01-01T00:00:00.000Z')
    const existing = [{ environment: 'preview', provider: 'supabase', instance_id: 'existing-uuid', initialized_at: initializedAt }]
    expect(decideSeedAction(existing, true)).toEqual({
      action: 'overwrite',
      preservedInstanceId: 'existing-uuid',
      preservedInitializedAt: initializedAt,
    })
  })

  it('既存行が複数件（異常系）かつ --force ありなら、先頭行のinstance_idを代表値として引き継ぐ', () => {
    const existing = [
      { environment: 'preview', provider: 'supabase', instance_id: 'first-uuid', initialized_at: new Date('2026-01-01') },
      { environment: 'production', provider: 'planetscale', instance_id: 'second-uuid', initialized_at: new Date('2026-02-01') },
    ]
    const result = decideSeedAction(existing, true)
    expect(result).toMatchObject({ action: 'overwrite', preservedInstanceId: 'first-uuid' })
  })

  it('既存行が複数件（異常系）かつ --force 無しなら reject', () => {
    const existing = [
      { environment: 'preview', provider: 'supabase', instance_id: 'first-uuid', initialized_at: new Date('2026-01-01') },
      { environment: 'production', provider: 'planetscale', instance_id: 'second-uuid', initialized_at: new Date('2026-02-01') },
    ]
    expect(decideSeedAction(existing, false)).toEqual({ action: 'reject', existingRows: existing })
  })
})
