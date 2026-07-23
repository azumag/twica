import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Retired Supabase admin compatibility facade.
 *
 * The application runtime is PlanetScale-only. This module remains temporarily
 * because deleting every PostgREST branch is a larger mechanical cleanup, but
 * it no longer imports or constructs the Supabase SDK at runtime and never
 * reads a Supabase URL/key. Existing parity tests replace this module with a
 * fixture from tests/setup.ts.
 *
 * A Proxy is returned so old pg-capable routes may still initialize an admin
 * variable before their driver branch without crashing after all Supabase
 * secrets are deleted. Any actual property access is a regression and fails
 * immediately with a precise error instead of attempting the retired service.
 */
function createRetiredSupabaseClient(): SupabaseClient {
  return new Proxy({} as SupabaseClient, {
    get() {
      throw new Error(
        '[supabase] Retired runtime path accessed. This operation must use the pg/PlanetScale implementation.'
      )
    },
  })
}

let supabaseAdmin: SupabaseClient | null = null

/** Safe to call in pg routes; no credentials, SDK client, or I/O are resolved. */
export function getSupabaseAdmin(): SupabaseClient {
  supabaseAdmin ??= createRetiredSupabaseClient()
  return supabaseAdmin
}

let supabaseAdminNoCache: SupabaseClient | null = null

/** Compatibility alias for former no-store callers; behaviour is identical. */
export function getSupabaseAdminNoCache(): SupabaseClient {
  supabaseAdminNoCache ??= createRetiredSupabaseClient()
  return supabaseAdminNoCache
}
