import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { localAdminApiPlugin } from './dev/localAdminApi'

// Vite configuration for the Twica Dashboard
// This is a separate admin dashboard that connects to Supabase in read-only mode
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
