import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { localAdminApiPlugin } from './dev/localAdminApi'
import { ALLOW_EXTERNAL_KEY, resolveDevServerBinding } from './dev/devServerBinding'

// ブラウザはローカルの /__admin API だけを呼び、DB資格情報は受け取らない。
// DB接続はViteのNode側プラグインからpostgres.jsで行うため、クライアントバンドルへ
// DASHBOARD_DATABASE_URLが混入しない。
//
// bind 先の決定（既定 loopback / 明示オプトインで外部公開）は
// dev/devServerBinding.ts に切り出してある。理由と設計判断はそちらの
// コメントを参照（テストから直接検証するため）。
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  const binding = resolveDevServerBinding(env)
  if (binding.warning) {
    console.warn(`[analysis] ${binding.warning}`)
  }
  if (binding.external) {
    // 監査可能性のため、公開モードで起動した事実を必ず可視化する。
    console.warn(
      `[analysis] ${ALLOW_EXTERNAL_KEY}=1: dev server を全インターフェースへ公開します。` +
        '信頼できるネットワーク以外では使用しないでください。',
    )
  }

  return {
    plugins: [react(), localAdminApiPlugin(env)],
    server: {
      port: 5173,
      host: binding.host,
      ...(binding.allowedHosts ? { allowedHosts: binding.allowedHosts } : {}),
    },
  }
})
