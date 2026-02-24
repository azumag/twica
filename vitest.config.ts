import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', '.next', 'dist'],
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['tests/setup.ts'],
    // プロセスリーク対策: タイムアウトとクリーンアップ設定
    testTimeout: 30000, // 30秒でテストをタイムアウト
    hookTimeout: 10000, // 10秒でフックをタイムアウト
    teardownTimeout: 10000, // 10秒でクリーンアップをタイムアウト
    // フォークプールを使用（スレッドプールよりも安全にプロセスを管理）
    pool: 'forks',
    poolOptions: {
      forks: {
        // 並列実行数を制限してリソース消費を抑制
        maxForks: 4,
        minForks: 1,
      },
    },
    // サブエージェント実行時のさらなる安全対策
    isolate: true, // 各テストファイルを完全に分離
    fileParallelism: false, // ファイル並列実行を無効化（より安全）
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
