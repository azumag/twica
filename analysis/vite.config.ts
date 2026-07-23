import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { localAdminApiPlugin } from './dev/localAdminApi'

// Vite configuration for the Twica Dashboard
// The browser only talks to the local /__admin API. The dev-server backend is
// forced to postgres.js even if an old ANALYSIS_DB_DRIVER=supabase value remains
// in a developer environment, so deleting the Supabase project/keys cannot
// silently reactivate the retired path. Driver-parity tests invoke the helpers
// directly and do not use this Vite runtime configuration.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  env.ANALYSIS_DB_DRIVER = 'pg'

  return {
    plugins: [react(), localAdminApiPlugin(env)],
    server: {
      port: 5173,
      // Allow connections from any host for local development
      host: true,
    },
  }
})
