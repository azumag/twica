import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { Database } from '../types/database'

// Supabase client configuration for read-only dashboard access
// Uses dashboard-specific environment variables to isolate from the main application
const supabaseUrl = import.meta.env.VITE_DASHBOARD_SUPABASE_URL

// Prefer Service Role Key for full data access (bypasses RLS)
// Fall back to Anon Key if Service Role Key is not set
const supabaseKey =
  import.meta.env.VITE_DASHBOARD_SUPABASE_SERVICE_ROLE_KEY ||
  import.meta.env.VITE_DASHBOARD_SUPABASE_ANON_KEY

// Track which key type is being used for debugging
const isServiceRoleKey = !!import.meta.env.VITE_DASHBOARD_SUPABASE_SERVICE_ROLE_KEY

// Validate environment variables are set
if (!supabaseUrl || !supabaseKey) {
  console.error(
    'Missing Supabase environment variables. Please set VITE_DASHBOARD_SUPABASE_URL and either VITE_DASHBOARD_SUPABASE_SERVICE_ROLE_KEY or VITE_DASHBOARD_SUPABASE_ANON_KEY in .env.local'
  )
} else {
  // Log which key type is being used (helpful for debugging)
  console.log(`Dashboard Supabase client initialized with ${isServiceRoleKey ? 'Service Role Key (RLS bypassed)' : 'Anon Key (RLS enforced)'}`)
}

// Create Supabase client instance
// When using Service Role Key, RLS is bypassed allowing full read access to all tables
// IMPORTANT: This dashboard is for local admin use only - never expose Service Role Key publicly
export const supabase: SupabaseClient<Database> = createClient<Database>(
  supabaseUrl || '',
  supabaseKey || ''
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
