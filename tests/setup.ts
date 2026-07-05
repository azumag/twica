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
// エクスポート形状は実モジュール（src/lib/db/client.ts）の実行時エクスポート（getDb のみ）と一致させること。
vi.mock('@/lib/db/client', () => ({
  getDb: vi.fn(() => {
    throw new Error(
      'getDb() must not be called in unit tests: DB_DRIVER defaults to postgrest. ' +
        'Override with vi.mocked(getDb).mockResolvedValue(...) to test the pg path.'
    )
  }),
}))
