import { vi } from 'vitest'
import '@testing-library/jest-dom'
import { createMockSupabaseClient } from './utils/supabase-mock'

// Setup environment variables
process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000'
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'test-publishable-key'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
process.env.SUPABASE_SECRET_KEY = 'test-secret-key'
process.env.TWITCH_CLIENT_SECRET = 'test-client-secret'
process.env.NEXT_PUBLIC_TWITCH_CLIENT_ID = 'test-client-id'
process.env.TWITCH_EVENTSUB_SECRET = 'test-eventsub-secret'
process.env.CSRF_SIGNING_KEY = 'test-csrf-signing-key'
process.env.CSRF_TOKEN_SALT = 'test-csrf-token-salt-at-least-32-characters-long'
process.env.BLOB_READ_WRITE_TOKEN = 'test-blob-read-write-token'
process.env.CSRF_ALLOW_ALL_LOCAL = 'false'

// Mock clipboard API
Object.defineProperty(global.navigator, 'clipboard', {
  value: {
    writeText: vi.fn(),
  },
  writable: true,
})

// Global mocks
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(() => createMockSupabaseClient()),
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => createMockSupabaseClient()),
  // logger.error → logErrorFromLogger → logErrorToSupabase で使用される
  getSupabaseAdmin: vi.fn(() => createMockSupabaseClient()),
}))

// #570: pg 直結経路（postgres.js + Drizzle）のグローバルモック。
// 既存テストは DB_DRIVER 未設定（= 'postgrest' 経路）で動くため getDb は呼ばれない。
// 万一呼ばれた場合はフラグ分岐漏れ（設計違反）を即検出できるよう throw するスタブにする。
// pg 経路をテストしたいファイルでは vi.mocked(getDb).mockResolvedValue(...) で上書きする。
//
// エクスポート形状は実モジュール（src/lib/db/client.ts）の実行時エクスポートと一致させる
// こと。#688 で normalizePgTimestampString / installIsoTimestampParsers が追加され、
// getDb 以外にも実行時エクスポートが増えた。この2つは DB 接続を持たない純関数
// （timestamp 文字列の正規化・postgres.js クライアントへのパーサ差し替え）なので、
// vi.importActual で実体を re-export し、getDb だけを throw スタブに差し替える
// （docs/TESTING_SUPABASE_MOCKS.md や tests/unit/gacha-history-api.test.ts 等の
// `@/lib/supabase/admin` importOriginal パターンと同じ方針。手動での形状同期を避け、
// #688 のようなエクスポート追加時にこのファイルを追随し忘れるリスクを構造的に消す）。
// なお tests/unit/db-client.test.ts / db-client-timestamp-normalization.test.ts は
// 冒頭で vi.unmock('@/lib/db/client') してこのグローバルモック自体を無効化した上で
// 実装本体（getDb 含む）を検証しているため、ここでの re-export 方式とは独立している。
vi.mock('@/lib/db/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/client')>()
  return {
    ...actual,
    getDb: vi.fn(() => {
      throw new Error(
        'getDb() must not be called in unit tests: DB_DRIVER defaults to postgrest. ' +
          'Override with vi.mocked(getDb).mockResolvedValue(...) to test the pg path.'
      )
    }),
  }
})
