import { isLegacySupabaseEnabled } from './flags'

/**
 * Database target selection.
 *
 * PlanetScale is the authoritative production database after the Phase 2
 * cutover. Supabase may be selected only inside the explicitly enabled legacy
 * compatibility sandbox. This makes an unset, invalid, or stale
 * DB_TARGET=supabase value safe after the Supabase project is shut down.
 */
export type DbTarget = 'supabase' | 'planetscale'

export function getDbTarget(): DbTarget {
  const raw = process.env.DB_TARGET?.trim()

  if (raw === 'planetscale') {
    return 'planetscale'
  }

  if (isLegacySupabaseEnabled()) {
    // Preserve the old default for PostgREST/driver-parity tests only.
    return raw === 'planetscale' ? 'planetscale' : 'supabase'
  }

  return 'planetscale'
}
