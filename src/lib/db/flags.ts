/*
 * DB driver selection
 *
 * Supabase/PostgREST was retained during the staged migration as an emergency
 * rollback path. After the PlanetScale cutover that behaviour is dangerous:
 * an unset, misspelled, or stale environment variable can silently send only
 * part of a request to the retired database. Runtime traffic therefore fails
 * safe to the pg driver.
 *
 * The compatibility path exists only for old driver-parity fixtures. Both
 * NODE_ENV=test and TWICA_ENABLE_LEGACY_SUPABASE=true are required, so an
 * accidentally retained production/preview variable cannot reactivate it.
 */

export type DbDriverMode = 'postgrest' | 'pg-read' | 'pg'

const LEGACY_SUPABASE_ENV = 'TWICA_ENABLE_LEGACY_SUPABASE'

/** Whether test-only Supabase/PostgREST compatibility fixtures may run. */
export function isLegacySupabaseEnabled(): boolean {
  return process.env.NODE_ENV === 'test'
    && process.env[LEGACY_SUPABASE_ENV]?.trim().toLowerCase() === 'true'
}

/**
 * Resolve the database driver for ordinary application reads/writes.
 *
 * Production/preview: always `pg`, including when DB_DRIVER is unset, invalid,
 * `postgrest`, or `pg-read`. `pg-read` is unsafe without Supabase because its
 * writes intentionally used PostgREST.
 *
 * Tests may explicitly opt into the former staged-migration semantics so the
 * existing parity fixtures remain useful until their mechanical deletion.
 */
export function getDbDriverMode(): DbDriverMode {
  const raw = process.env.DB_DRIVER?.trim()

  if (raw === 'pg') {
    return 'pg'
  }

  if (isLegacySupabaseEnabled()) {
    if (raw === 'pg-read') return 'pg-read'
    if (raw === 'postgrest') return 'postgrest'
    return 'postgrest'
  }

  return 'pg'
}

/** Whether reads use postgres.js + Drizzle. */
export function isPgReadEnabled(): boolean {
  const mode = getDbDriverMode()
  return mode === 'pg-read' || mode === 'pg'
}

/** Whether writes use postgres.js + Drizzle. */
export function isPgWriteEnabled(): boolean {
  return getDbDriverMode() === 'pg'
}

/**
 * Driver for the gacha critical path. The former postgrest override is honoured
 * only inside the explicit test compatibility sandbox.
 */
export function getGachaDbDriver(): 'postgrest' | 'pg' {
  const raw = process.env.GACHA_DB_DRIVER?.trim()

  if (raw === 'pg') {
    return 'pg'
  }
  if (raw === 'postgrest' && isLegacySupabaseEnabled()) {
    return 'postgrest'
  }

  if (isPgWriteEnabled()) {
    return 'pg'
  }

  return isLegacySupabaseEnabled() ? 'postgrest' : 'pg'
}
