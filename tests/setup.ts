import { vi } from 'vitest'

// Setup environment variables
process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000'
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
process.env.TWITCH_CLIENT_ID = 'test-client-id'
process.env.TWITCH_CLIENT_SECRET = 'test-client-secret'
process.env.NEXT_PUBLIC_TWITCH_CLIENT_ID = 'test-client-id'
process.env.TWITCH_EVENTSUB_SECRET = 'test-eventsub-secret'
process.env.CSRF_SIGNING_KEY = 'test-csrf-signing-key'
process.env.CSRF_TOKEN_SALT = 'test-csrf-token-salt-at-least-32-characters-long'
process.env.BLOB_READ_WRITE_TOKEN = 'test-blob-read-write-token'
process.env.CSRF_ALLOW_ALL_LOCAL = 'false'

// Global mocks
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(),
}))
