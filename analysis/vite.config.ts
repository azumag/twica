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
      // ループバックのみで待ち受ける。以前の `host: true` は 0.0.0.0（LAN全体）に公開しており、
      // 同一ネットワークの他端末から本番DBへ直結した /__admin に到達できた。
      // 管理APIの接続元検証(isLoopback)に頼らず、そもそもネットワークに晒さない。
      host: '127.0.0.1',
      // 他オリジンの Web ページが dev サーバーの応答（index.html に埋め込む管理APIトークン
      // を含む）を読めないよう CORS ヘッダを付けない。このSPAは同一オリジンでしか使わない。
      cors: false,
    },
  }
})
