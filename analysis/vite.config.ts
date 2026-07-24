import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { localAdminApiPlugin } from './dev/localAdminApi'

// ブラウザはローカルの /__admin API だけを呼び、DB資格情報は受け取らない。
// DB接続はViteのNode側プラグインからpostgres.jsで行うため、クライアントバンドルへ
// DASHBOARD_DATABASE_URLが混入しない。
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
