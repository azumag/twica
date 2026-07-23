import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { isLegacySupabaseEnabled } from '@/lib/db/flags'
import { getSupabaseElevatedKey } from './keys'

/**
 * Read and validate the retired Supabase credentials.
 *
 * This function must only run after a real PostgREST operation is attempted.
 * Merely importing a pg-capable route or calling getSupabaseAdmin() must remain
 * safe when the Supabase project and all of its environment variables have
 * been removed.
 */
function getSupabaseCredentials(): { url: string; key: string } {
  if (!isLegacySupabaseEnabled()) {
    throw new Error(
      '[supabase] Legacy runtime access is disabled. A PostgREST path leaked into the pg/PlanetScale runtime.'
    )
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const key = getSupabaseElevatedKey()

  if (!url || !key) {
    throw new Error('Missing Supabase environment variables')
  }

  return { url, key }
}

/**
 * Build a lazy Supabase client proxy.
 *
 * Several migrated routes still create an admin-client variable before their
 * `isPg*Enabled()` branch and then use it only in the legacy branch. The old
 * eager factory validated Supabase secrets immediately, so those otherwise-pg
 * requests crashed as soon as the retired secrets were deleted. The proxy
 * preserves the existing SupabaseClient type/API while deferring credentials,
 * SDK construction, and network capability until a property such as `.from`
 * or `.rpc` is actually accessed.
 *
 * Binding function properties to the real client is required because SDK
 * methods rely on their instance `this` value.
 */
function createLazySupabaseClient(noCache: boolean): SupabaseClient {
  let resolvedClient: SupabaseClient | null = null

  const resolveClient = (): SupabaseClient => {
    if (resolvedClient) return resolvedClient

    const { url, key } = getSupabaseCredentials()
    resolvedClient = noCache
      ? createClient(url, key, {
          global: {
            fetch: (requestUrl, options = {}) =>
              fetch(requestUrl, { ...options, cache: 'no-store' }),
          },
        })
      : createClient(url, key)
    return resolvedClient
  }

  return new Proxy({} as SupabaseClient, {
    get(_target, property) {
      const client = resolveClient()
      const value = Reflect.get(client as object, property, client)
      return typeof value === 'function' ? value.bind(client) : value
    },
  })
}

let supabaseAdmin: SupabaseClient | null = null

/**
 * Legacy admin client. Safe to request in the pg runtime; it is not resolved
 * unless legacy code actually performs a Supabase operation.
 */
export function getSupabaseAdmin(): SupabaseClient {
  supabaseAdmin ??= createLazySupabaseClient(false)
  return supabaseAdmin
}

let supabaseAdminNoCache: SupabaseClient | null = null

/** Lazy no-store variant used by the legacy EventSub compatibility path. */
export function getSupabaseAdminNoCache(): SupabaseClient {
  supabaseAdminNoCache ??= createLazySupabaseClient(true)
  return supabaseAdminNoCache
}
