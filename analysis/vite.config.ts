import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { localAdminApiPlugin } from './dev/localAdminApi'

// Vite configuration for the Twica Dashboard
// The browser only talks to the local /__admin API. The dev-server backend is
// forced to postgres.js unless an operator explicitly opts into the retired
// compatibility path; therefore deleting every Supabase URL/key does not
// change the dashboard's runtime route.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  if (!env.ANALYSIS_DB_DRIVER) {
    env.ANALYSIS_DB_DRIVER = 'pg'
  }

  return {
    plugins: [react(), localAdminApiPlugin(env)],
    server: {
      port: 5173,
      // Allow connections from any host for local development
      host: true,
    },
  }
})
