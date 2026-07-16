import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { localAdminApiPlugin } from './dev/localAdminApi'

// Vite configuration for the Twica Dashboard
// This is a separate admin dashboard. The browser only talks to the local
// /__admin API (see dev/localAdminApi.ts's Vite plugin below); it has no
// direct DB client of its own (#701). The dev-server-side plugin itself still
// defaults to Supabase (with an opt-in postgres.js path via ANALYSIS_DB_DRIVER,
// #700) until the DB migration's Phase 2 cutover.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react(), localAdminApiPlugin(env)],
    server: {
      port: 5173,
      // Allow connections from any host for local development
      host: true,
    },
  }
})
