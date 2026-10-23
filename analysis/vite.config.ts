import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { localAdminApiPlugin } from './dev/localAdminApi'
import {
  ALLOW_EXTERNAL_KEY,
  resolveDevServerBinding,
  toServerOptions,
} from './dev/devServerBinding'

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
        '信頼できるネットワーク以外では使用しないでください。' +
        'なお /__admin は非loopbackの送信元を拒否するため、管理APIは利用できません。',
    )
  }

  return {
    plugins: [react(), localAdminApiPlugin(env)],
    // 他オリジンの Web ページが dev サーバーの応答（index.html に埋め込む管理APIトークン
    // を含む）を読めないよう CORS ヘッダを付けない。このSPAは同一オリジンでしか使わない。
    // bind 先の既定は loopback（明示オプトイン時のみ外部公開）で、
    // dev/devServerBinding.ts が決定する。
    server: { ...toServerOptions(binding), cors: false },
  }
})
