import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite configuration for the Twica Dashboard
// This is a separate admin dashboard that connects to Supabase in read-only mode
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Allow connections from any host for local development
    host: true,
  },
})
