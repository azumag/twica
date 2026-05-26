import { vi } from 'vitest'
import '@testing-library/jest-dom'
import { createMockSupabaseClient } from './utils/supabase-mock'

const localStorageStore = new Map<string, string>()
const localStorageMock: Storage = {
  get length() {
    return localStorageStore.size
  },
  clear: vi.fn(() => localStorageStore.clear()),
  getItem: vi.fn((key: string) => localStorageStore.get(key) ?? null),
  key: vi.fn((index: number) => Array.from(localStorageStore.keys())[index] ?? null),
  removeItem: vi.fn((key: string) => {
    localStorageStore.delete(key)
  }),
  setItem: vi.fn((key: string, value: string) => {
    localStorageStore.set(key, String(value))
  }),
}

// Node 25 exposes an experimental global localStorage that is separate from
// happy-dom and lacks clear(). Keep bare localStorage and window.localStorage
// on the same browser-like Storage object for component tests.
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: localStorageMock,
})
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: localStorageMock,
})

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
