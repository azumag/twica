import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { createClientMock } = vi.hoisted(() => ({
  createClientMock: vi.fn(),
}))

// tests/setup.ts mocks the compatibility client for legacy parity tests. This
// file deliberately loads the production lazy implementation instead.
vi.unmock('@/lib/supabase/admin')
vi.mock('@supabase/supabase-js', () => ({
  createClient: createClientMock,
}))

import {
  getDbDriverMode,
  getGachaDbDriver,
  isPgReadEnabled,
  isPgWriteEnabled,
  isLegacySupabaseEnabled,
} from '@/lib/db/flags'
import { getDbTarget } from '@/lib/db/target'
import { getSupabaseAdmin, getSupabaseAdminNoCache } from '@/lib/supabase/admin'
import { validateEnvVars } from '@/lib/env-validation'

const SUPABASE_ENV_NAMES = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SECRET_KEY',
  'SUPABASE_DB_URL',
] as const

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('TWICA_ENABLE_LEGACY_SUPABASE', undefined)
  vi.stubEnv('DB_DRIVER', undefined)
  vi.stubEnv('GACHA_DB_DRIVER', undefined)
  vi.stubEnv('DB_TARGET', undefined)
  for (const name of SUPABASE_ENV_NAMES) {
    vi.stubEnv(name, undefined)
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('full Supabase shutdown runtime', () => {
  it('fails safe to pg + PlanetScale when every routing variable is absent', () => {
    expect(isLegacySupabaseEnabled()).toBe(false)
    expect(getDbDriverMode()).toBe('pg')
    expect(isPgReadEnabled()).toBe(true)
    expect(isPgWriteEnabled()).toBe(true)
    expect(getGachaDbDriver()).toBe('pg')
    expect(getDbTarget()).toBe('planetscale')
  })

  it('ignores stale rollback values when the explicit legacy gate is absent', () => {
    vi.stubEnv('DB_DRIVER', 'postgrest')
    vi.stubEnv('GACHA_DB_DRIVER', 'postgrest')
    vi.stubEnv('DB_TARGET', 'supabase')

    expect(getDbDriverMode()).toBe('pg')
    expect(getGachaDbDriver()).toBe('pg')
    expect(getDbTarget()).toBe('planetscale')
  })

  it('also treats pg-read as pg because its writes previously required PostgREST', () => {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    expect(getDbDriverMode()).toBe('pg')
    expect(isPgWriteEnabled()).toBe(true)
  })

  it('does not require any Supabase URL or key during startup validation', () => {
    expect(validateEnvVars()).toEqual({ valid: true, missing: [] })
  })

  it('may construct dormant admin handles without resolving credentials or the SDK', () => {
    expect(() => getSupabaseAdmin()).not.toThrow()
    expect(() => getSupabaseAdminNoCache()).not.toThrow()
    expect(createClientMock).not.toHaveBeenCalled()
  })

  it('fails loudly if a leaked compatibility query actually tries to use Supabase', () => {
    expect(() => getSupabaseAdmin().from).toThrow(
      '[supabase] Legacy runtime access is disabled'
    )
    expect(createClientMock).not.toHaveBeenCalled()
  })

  it('allows the retired route only under an explicit compatibility gate', () => {
    vi.stubEnv('TWICA_ENABLE_LEGACY_SUPABASE', 'true')
    vi.stubEnv('DB_DRIVER', 'postgrest')
    vi.stubEnv('GACHA_DB_DRIVER', 'postgrest')
    vi.stubEnv('DB_TARGET', 'supabase')

    expect(isLegacySupabaseEnabled()).toBe(true)
    expect(getDbDriverMode()).toBe('postgrest')
    expect(getGachaDbDriver()).toBe('postgrest')
    expect(getDbTarget()).toBe('supabase')
  })
})
