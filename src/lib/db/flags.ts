/*
 * DB driver selection
 *
 * Supabase/PostgREST was retained during the staged migration as an emergency
 * rollback path. After the PlanetScale cutover that behaviour is dangerous:
 * an unset, misspelled, or stale environment variable can silently send only
 * part of a request to the retired database. Runtime traffic therefore fails
 * safe to the pg driver.
 *
 * The legacy path remains available only behind TWICA_ENABLE_LEGACY_SUPABASE.
 * It exists for the existing PostgREST parity tests and for an explicitly
 * controlled local investigation. Production/preview must not set it.
 */

export type DbDriverMode = 'postgrest' | 'pg-read' | 'pg'

const LEGACY_SUPABASE_ENV = 'TWICA_ENABLE_LEGACY_SUPABASE'

/**
 * Whether the retired Supabase/PostgREST compatibility path may be used.
 *
 * This flag is intentionally independent from DB_DRIVER. A stale
 * DB_DRIVER=postgrest or DB_DRIVER=pg-read must not reactivate Supabase after
 * the project has been shut down. Tests opt in from tests/setup.ts so the old
 * driver-parity fixtures can remain useful while the dead code is removed in
 * a later cleanup.
 */
export function isLegacySupabaseEnabled(): boolean {
  return process.env[LEGACY_SUPABASE_ENV]?.trim().toLowerCase() === 'true'
}

/**
 * Resolve the database driver for ordinary application reads/writes.
 *
 * Production behaviour (legacy flag absent): always `pg`, including when
 * DB_DRIVER is unset, invalid, `postgrest`, or `pg-read`. `pg-read` is not safe
 * without Supabase because its writes intentionally use PostgREST.
 *
 * Compatibility behaviour (legacy flag explicitly true): preserve the former
 * staged-migration semantics so parity tests can exercise PostgREST/pg-read.
 */
export function getDbDriverMode(): DbDriverMode {
  const raw = process.env.DB_DRIVER?.trim()

  if (raw === 'pg') {
    return 'pg'
  }

  if (isLegacySupabaseEnabled()) {
    if (raw === 'pg-read') return 'pg-read'
    if (raw === 'postgrest') return 'postgrest'
    // Preserve the pre-cutover default only inside the explicit compatibility
    // sandbox. Invalid/missing values cannot reach this branch in production.
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
 * Driver for the gacha critical path.
 *
 * GACHA_DB_DRIVER=postgrest is honoured only while the explicit legacy flag is
 * enabled. This prevents a forgotten emergency rollback variable from routing
 * paid redemptions to a shut-down Supabase project.
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

  // Only reachable in the explicitly enabled compatibility sandbox
  // (DB_DRIVER=postgrest/pg-read).
  return isLegacySupabaseEnabled() ? 'postgrest' : 'pg'
}
