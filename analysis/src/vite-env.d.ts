/// <reference types="vite/client" />

// Vite environment variable type declarations
// Required for TypeScript to recognize import.meta.env
interface ImportMetaEnv {
  readonly VITE_DASHBOARD_SUPABASE_URL: string
  // Browser-visible key for the dashboard client
  readonly VITE_DASHBOARD_SUPABASE_PUBLISHABLE_KEY?: string
  // Secret keys are intentionally ignored by browser code. Keep them non-VITE
  // and consume them only from the local Vite admin middleware.
  readonly VITE_DASHBOARD_SUPABASE_SECRET_KEY?: string
  readonly VITE_DASHBOARD_SUPABASE_SERVICE_ROLE_KEY?: string
  // Legacy anon key fallback
  readonly VITE_DASHBOARD_SUPABASE_ANON_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
