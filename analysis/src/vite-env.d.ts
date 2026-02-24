/// <reference types="vite/client" />

// Vite environment variable type declarations
// Required for TypeScript to recognize import.meta.env
interface ImportMetaEnv {
  readonly VITE_DASHBOARD_SUPABASE_URL: string
  // Service Role Key - bypasses RLS (recommended for local admin dashboard)
  readonly VITE_DASHBOARD_SUPABASE_SERVICE_ROLE_KEY?: string
  // Anon Key - subject to RLS policies
  readonly VITE_DASHBOARD_SUPABASE_ANON_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
