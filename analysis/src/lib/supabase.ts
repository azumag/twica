import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { Database } from '../types/database'

// Supabase client configuration for read-only dashboard access
// Uses dashboard-specific environment variables to isolate from the main application
const supabaseUrl = import.meta.env.VITE_DASHBOARD_SUPABASE_URL

// Browser-visible client key. Secret/service-role keys must stay on the local
// Vite server side and are used via /__admin endpoints for protected data.
const supabaseKey =
  import.meta.env.VITE_DASHBOARD_SUPABASE_PUBLISHABLE_KEY ||
  import.meta.env.VITE_DASHBOARD_SUPABASE_ANON_KEY

const configuredSecretKey = !!import.meta.env.VITE_DASHBOARD_SUPABASE_SECRET_KEY ||
  !!import.meta.env.VITE_DASHBOARD_SUPABASE_SERVICE_ROLE_KEY

// Validate environment variables are set
if (!supabaseUrl || !supabaseKey) {
  console.error(
    'Missing Supabase environment variables. Please set VITE_DASHBOARD_SUPABASE_URL and VITE_DASHBOARD_SUPABASE_PUBLISHABLE_KEY in .env.local'
  )
} else {
  console.log(
    `Dashboard Supabase client initialized with ${
      import.meta.env.VITE_DASHBOARD_SUPABASE_PUBLISHABLE_KEY ? 'Publishable Key' : 'legacy Anon Key'
    }`
  )
}

if (configuredSecretKey) {
  console.warn(
    'A VITE_DASHBOARD_SUPABASE_SECRET_KEY/service-role key is configured, but browser code ignores it. Use DASHBOARD_SUPABASE_SECRET_KEY for the local __admin API instead.'
  )
}

// Create Supabase client instance
export const supabase: SupabaseClient<Database> = createClient<Database>(
  supabaseUrl || '',
  supabaseKey || '',
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  }
)

// Read-only query wrapper to ensure we only perform SELECT operations
// This provides an additional layer of safety on top of RLS policies
export const readOnlyQuery = {
  /**
   * Fetch all rows from a table with optional filters
   * @param table - The table name to query
   * @returns A Supabase query builder restricted to SELECT
   */
  from: <T extends keyof Database['public']['Tables']>(table: T) => {
    return supabase.from(table).select()
  },

  /**
   * Execute a raw SQL query (read-only)
   * Note: This is intentionally not exposed to prevent arbitrary SQL execution
   */
}
