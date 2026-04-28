import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cookies } from 'next/headers'
import { logger } from '@/lib/logger'

import { COOKIE_NAMES, ERROR_MESSAGES } from '@/lib/constants'
import { setCSRFToken, validateCSRFToken, hashToken, clearCSRFToken, hashIP, sanitizeURL } from '@/lib/csrf'
import { signSession, verifySession } from '@/lib/session'

// Mock interface for cookie store with essential methods needed for testing
// Note: We use 'any' when passing to mockResolvedValue since the full RequestCookies
// type requires MapIterator which is complex to mock properly in tests
interface MockCookieStore {
  get: ReturnType<typeof vi.fn>
  set: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
}

vi.mock('@/lib/constants', async () => {
  const actual = await vi.importActual<typeof import('@/lib/constants')>('@/lib/constants')
  return {
    ...actual,
    CSRF_CONFIG: {
      TOKEN_LENGTH: actual.CSRF_CONFIG.TOKEN_LENGTH,
      MAX_RETRY_COUNT: actual.CSRF_CONFIG.MAX_RETRY_COUNT,
      RETRY_DELAY_MS: actual.CSRF_CONFIG.RETRY_DELAY_MS,
      ALLOW_LOCAL_ORIGINS: false,
      ALLOWED_ORIGINS: ['https://example.com', 'http://localhost:3000'],
    },
    getSessionCookieOptions: () => ({
      httpOnly: true,
      secure: false,
      sameSite: 'lax' as const,
      path: '/',
      maxAge: 7 * 24 * 60 * 60,
    }),
    getDeleteCookieOptions: () => ({
      httpOnly: true,
      secure: false,
      sameSite: 'lax' as const,
      path: '/',
      maxAge: 0,
    }),
  }
})

vi.mock('next/headers')
vi.mock('@/lib/logger')
vi.mock('@/lib/sentry/error-handler')

const mockCookies = vi.mocked(cookies)
const mockLogger = vi.mocked(logger)

// Helper function to create a mock cookie store with essential methods for testing
function createMockCookieStore(overrides: {
  get?: ReturnType<typeof vi.fn>
  set?: ReturnType<typeof vi.fn>
  delete?: ReturnType<typeof vi.fn>
} = {}): MockCookieStore {
  return {
    get: overrides.get ?? vi.fn(),
    set: overrides.set ?? vi.fn(),
    delete: overrides.delete ?? vi.fn(),
  }
}

describe('CSRF Protection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    vi.stubEnv('CSRF_TOKEN_SALT', 'test-salt-for-csrf-token-hashing')

    const mockCookieStore = createMockCookieStore()


    mockCookies.mockResolvedValue(mockCookieStore as any)
  })

  describe('hashToken', () => {
    it('should generate consistent hashes', async () => {
      const token = 'test-token'
      const hash1 = await hashToken(token)
      const hash2 = await hashToken(token)
      expect(hash1).toBe(hash2)
      expect(typeof hash1).toBe('string')
      expect(hash1.length).toBe(64) // SHA-256 produces 64 hex characters
    })

    it('should generate different hashes for different tokens', async () => {
      const hash1 = await hashToken('token1')
      const hash2 = await hashToken('token2')
      expect(hash1).not.toBe(hash2)
    })
  })

  describe('setCSRFToken', () => {
    it('should generate and store CSRF token hash in session and httpOnly cookie', async () => {
      const sessionData = {
        twitchUserId: 'user123',
        twitchUsername: 'testuser',
        twitchDisplayName: 'Test User',
        twitchProfileImageUrl: 'https://example.com/image.png',
        broadcasterType: 'affiliate',
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        version: 1
      }

      const mockCookieStore = createMockCookieStore({
        get: vi.fn().mockReturnValue({ value: JSON.stringify(sessionData) }),
        set: vi.fn(),
      })
  
    mockCookies.mockResolvedValue(mockCookieStore as any)

      const token = await setCSRFToken()

      // Token should be 64 hex characters (32 bytes * 2)
      expect(token).toMatch(/^[a-f0-9]{64}$/)

      expect(mockCookieStore.set).toHaveBeenCalledTimes(2)

      // First call: session with csrfTokenHash
      expect(mockCookieStore.set).toHaveBeenNthCalledWith(
        1,
        COOKIE_NAMES.SESSION,
        expect.stringContaining('"csrfTokenHash"'),
        expect.any(Object)
      )
      // Second call: CSRF token cookie
      expect(mockCookieStore.set).toHaveBeenNthCalledWith(
        2,
        COOKIE_NAMES.CSRF_TOKEN,
        expect.any(String),
        expect.objectContaining({
          httpOnly: true,
        })
      )

      expect(mockLogger.info).toHaveBeenCalledWith('CSRF token generated for user user123')
    })

    it('should return existing token if already exists', async () => {
      const sessionData = {
        twitchUserId: 'user123',
        twitchUsername: 'testuser',
        twitchDisplayName: 'Test User',
        twitchProfileImageUrl: 'https://example.com/image.png',
        broadcasterType: 'affiliate',
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        csrfTokenHash: 'existing-hash',
        version: 1
      }

      const mockCookieStore = createMockCookieStore({
        get: vi.fn((name) => {
          if (name === COOKIE_NAMES.SESSION) {
            return { value: JSON.stringify(sessionData) }
          }
          if (name === COOKIE_NAMES.CSRF_TOKEN) {
            return { value: 'existing-token' }
          }
          return undefined
        }),
        set: vi.fn(),
      })
  
    mockCookies.mockResolvedValue(mockCookieStore as any)

      const token = await setCSRFToken()

      expect(token).toBe('existing-token')
      expect(mockCookieStore.set).not.toHaveBeenCalled()
    })

    it('should throw error when no session found', async () => {
      const mockCookieStore = createMockCookieStore({
        get: vi.fn().mockReturnValue(undefined),
        set: vi.fn(),
      })
  
    mockCookies.mockResolvedValue(mockCookieStore as any)

      await expect(setCSRFToken()).rejects.toThrow('No session found')
    })

    it('should write back a signed session cookie when SESSION_COOKIE_SECRET is set', async () => {
      vi.stubEnv('SESSION_COOKIE_SECRET', 'test-secret-key-32-chars-abcdefgh')

      const sessionData = {
        twitchUserId: 'user123',
        twitchUsername: 'testuser',
        twitchDisplayName: 'Test User',
        twitchProfileImageUrl: 'https://example.com/image.png',
        broadcasterType: 'affiliate',
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        version: 1,
      }

      const signedSession = await signSession(JSON.stringify(sessionData))
      const mockCookieStore = createMockCookieStore({
        get: vi.fn().mockReturnValue({ value: signedSession }),
        set: vi.fn(),
      })

      mockCookies.mockResolvedValue(mockCookieStore as any)

      await setCSRFToken()

      const signedSessionValue = mockCookieStore.set.mock.calls[0][1]
      const verifiedPayload = await verifySession(signedSessionValue)

      expect(signedSessionValue).toContain('.')
      expect(verifiedPayload).toContain('"csrfTokenHash"')
    })
  })

  describe('validateCSRFToken', () => {
    it('should validate matching tokens from httpOnly cookie', async () => {
      // Generate a real token and hash for testing
      const token = 'a'.repeat(64)
      const tokenHash = await hashToken(token)

      const sessionData = {
        twitchUserId: 'user123',
        twitchUsername: 'testuser',
        twitchDisplayName: 'Test User',
        twitchProfileImageUrl: 'https://example.com/image.png',
        broadcasterType: 'affiliate',
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        csrfTokenHash: tokenHash,
        version: 1
      }

      const mockCookieStore = createMockCookieStore({
        get: vi.fn((name) => {
          if (name === COOKIE_NAMES.SESSION) {
            return { value: JSON.stringify(sessionData) }
          }
          if (name === COOKIE_NAMES.CSRF_TOKEN) {
            return { value: token }
          }
          return undefined
        }),
        set: vi.fn(),
      })

    mockCookies.mockResolvedValue(mockCookieStore as any)

      const request = new Request('https://example.com')

      const result = await validateCSRFToken(request)

      expect(result.valid).toBe(true)
    })

    // Issue #400: CSRF 検証は HttpOnly Cookie + Origin/Referer 方式に統一済み。
    // クライアントから X-CSRF-Token ヘッダが送られて来ても、サーバーはそれを参照
    // せず、Cookie に正しいトークンが入っていれば検証が通ることを保証する。
    it('should validate using cookie only and ignore X-CSRF-Token header', async () => {
      const token = 'a'.repeat(64)
      const tokenHash = await hashToken(token)

      const sessionData = {
        twitchUserId: 'user123',
        twitchUsername: 'testuser',
        twitchDisplayName: 'Test User',
        twitchProfileImageUrl: 'https://example.com/image.png',
        broadcasterType: 'affiliate',
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        csrfTokenHash: tokenHash,
        version: 1
      }

      const mockCookieStore = createMockCookieStore({
        get: vi.fn((name) => {
          if (name === COOKIE_NAMES.SESSION) {
            return { value: JSON.stringify(sessionData) }
          }
          if (name === COOKIE_NAMES.CSRF_TOKEN) {
            return { value: token }
          }
          return undefined
        }),
        set: vi.fn(),
      })

      mockCookies.mockResolvedValue(mockCookieStore as any)

      const request = new Request('https://example.com', {
        headers: { 'X-CSRF-Token': 'totally-bogus-header-value' },
      })

      const result = await validateCSRFToken(request)

      expect(result.valid).toBe(true)
    })

    it('should reject missing token in cookie', async () => {
      const sessionData = {
        twitchUserId: 'user123',
        twitchUsername: 'testuser',
        twitchDisplayName: 'Test User',
        twitchProfileImageUrl: 'https://example.com/image.png',
        broadcasterType: 'affiliate',
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        csrfTokenHash: 'session-hash',
        version: 1
      }

      const mockCookieStore = createMockCookieStore({
        get: vi.fn((name) => {
          if (name === COOKIE_NAMES.SESSION) {
            return { value: JSON.stringify(sessionData) }
          }
          return undefined
        }),
        set: vi.fn(),
      })
  
    mockCookies.mockResolvedValue(mockCookieStore as any)

      const request = new Request('https://example.com')

      const result = await validateCSRFToken(request)

      expect(result.valid).toBe(false)
      expect(result.error).toBe('CSRFトークンがCookieに見つかりません。ページを再読み込みしてください。')
    })

    it('should reject invalid token length', async () => {
      const sessionData = {
        twitchUserId: 'user123',
        twitchUsername: 'testuser',
        twitchDisplayName: 'Test User',
        twitchProfileImageUrl: 'https://example.com/image.png',
        broadcasterType: 'affiliate',
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        csrfTokenHash: 'session-hash',
        version: 1
      }

      const mockCookieStore = createMockCookieStore({
        get: vi.fn((name) => {
          if (name === COOKIE_NAMES.SESSION) {
            return { value: JSON.stringify(sessionData) }
          }
          if (name === COOKIE_NAMES.CSRF_TOKEN) {
            return { value: 'a'.repeat(63) } // Invalid length (should be 64)
          }
          return undefined
        }),
        set: vi.fn(),
      })
  
    mockCookies.mockResolvedValue(mockCookieStore as any)

      const request = new Request('https://example.com')

      const result = await validateCSRFToken(request)

      expect(result.valid).toBe(false)
      expect(result.error).toBe('CSRFトークンの長さが不正です。ページを再読み込みしてください。')
      expect(mockLogger.warn).toHaveBeenCalledWith('CSRF validation failed: Invalid token length', {
        userId: 'user123',
        expectedLength: 64,
        actualLength: 63,
      })
    })

    it('should reject when no session found', async () => {
      const mockCookieStore = createMockCookieStore({
        get: vi.fn().mockReturnValue(undefined),
        set: vi.fn(),
      })
  
    mockCookies.mockResolvedValue(mockCookieStore as any)

      const request = new Request('https://example.com')

      const result = await validateCSRFToken(request)

      expect(result.valid).toBe(false)
      expect(result.error).toBe('セッションが見つかりません。再度ログインしてください。')
    })

    it('should reject unsigned legacy session cookies when signature enforcement is enabled', async () => {
      vi.stubEnv('SESSION_COOKIE_SECRET', 'test-secret-key-32-chars-abcdefgh')

      const token = 'a'.repeat(64)
      const tokenHash = await hashToken(token)
      const sessionData = {
        twitchUserId: 'user123',
        twitchUsername: 'testuser',
        twitchDisplayName: 'Test User',
        twitchProfileImageUrl: 'https://example.com/image.png',
        broadcasterType: 'affiliate',
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        csrfTokenHash: tokenHash,
        version: 1,
      }

      const mockCookieStore = createMockCookieStore({
        get: vi.fn((name) => {
          if (name === COOKIE_NAMES.SESSION) {
            return { value: JSON.stringify(sessionData) }
          }
          if (name === COOKIE_NAMES.CSRF_TOKEN) {
            return { value: token }
          }
          return undefined
        }),
        set: vi.fn(),
      })

      mockCookies.mockResolvedValue(mockCookieStore as any)

      const result = await validateCSRFToken(new Request('https://example.com'))

      expect(result.valid).toBe(false)
      expect(result.error).toBe('セッションが見つかりません。再度ログインしてください。')
    })

    it('should accept valid origin header', async () => {
      const token = 'a'.repeat(64)
      const tokenHash = await hashToken(token)

      const sessionData = {
        twitchUserId: 'user123',
        twitchUsername: 'testuser',
        twitchDisplayName: 'Test User',
        twitchProfileImageUrl: 'https://example.com/image.png',
        broadcasterType: 'affiliate',
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        csrfTokenHash: tokenHash,
        version: 1
      }

      const mockCookieStore = createMockCookieStore({
        get: vi.fn((name) => {
          if (name === COOKIE_NAMES.SESSION) {
            return { value: JSON.stringify(sessionData) }
          }
          if (name === COOKIE_NAMES.CSRF_TOKEN) {
            return { value: token }
          }
          return undefined
        }),
        set: vi.fn(),
      })
  
    mockCookies.mockResolvedValue(mockCookieStore as any)

      const request = new Request('https://example.com', {
        headers: { 'origin': 'https://example.com' }
      })

      const result = await validateCSRFToken(request)

      expect(result.valid).toBe(true)
    })

    it('should reject invalid origin header', async () => {
      const token = 'a'.repeat(64)
      const tokenHash = await hashToken(token)

      const sessionData = {
        twitchUserId: 'user123',
        twitchUsername: 'testuser',
        twitchDisplayName: 'Test User',
        twitchProfileImageUrl: 'https://example.com/image.png',
        broadcasterType: 'affiliate',
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        csrfTokenHash: tokenHash,
        version: 1
      }

      const mockCookieStore = createMockCookieStore({
        get: vi.fn((name) => {
          if (name === COOKIE_NAMES.SESSION) {
            return { value: JSON.stringify(sessionData) }
          }
          if (name === COOKIE_NAMES.CSRF_TOKEN) {
            return { value: token }
          }
          return undefined
        }),
        set: vi.fn(),
      })
  
    mockCookies.mockResolvedValue(mockCookieStore as any)

      const request = new Request('https://example.com')
      const getSpy = vi.spyOn(request.headers, 'get').mockImplementation((name) => {
        if (name === 'origin') return 'https://malicious.com'
        if (name === 'referer') return null
        return null
      })

      const result = await validateCSRFToken(request)

      expect(result.valid).toBe(false)
      expect(result.error).toBe('Originヘッダーが許可リストにありません: https://malicious.com')
      expect(mockLogger.warn).toHaveBeenCalledWith('CSRF validation failed: Origin header not in allowed list', {
        userId: 'user123',
        origin: 'https://malicious.com',
        allowLocalOrigins: false,
        allowedOrigins: expect.any(Array),
        endpoint: '/',
      })

      getSpy.mockRestore()
    })

    it('should accept valid referer header when origin is missing', async () => {
      const token = 'a'.repeat(64)
      const tokenHash = await hashToken(token)

      const sessionData = {
        twitchUserId: 'user123',
        twitchUsername: 'testuser',
        twitchDisplayName: 'Test User',
        twitchProfileImageUrl: 'https://example.com/image.png',
        broadcasterType: 'affiliate',
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        csrfTokenHash: tokenHash,
        version: 1
      }

      const mockCookieStore = createMockCookieStore({
        get: vi.fn((name) => {
          if (name === COOKIE_NAMES.SESSION) {
            return { value: JSON.stringify(sessionData) }
          }
          if (name === COOKIE_NAMES.CSRF_TOKEN) {
            return { value: token }
          }
          return undefined
        }),
        set: vi.fn(),
      })
  
    mockCookies.mockResolvedValue(mockCookieStore as any)

      const request = new Request('https://example.com/api/test', {
        headers: { 'referer': 'https://example.com/page' }
      })

      const result = await validateCSRFToken(request)

      expect(result.valid).toBe(true)
    })

    it('should reject invalid referer header when origin is missing', async () => {
      const token = 'a'.repeat(64)
      const tokenHash = await hashToken(token)

      const sessionData = {
        twitchUserId: 'user123',
        twitchUsername: 'testuser',
        twitchDisplayName: 'Test User',
        twitchProfileImageUrl: 'https://example.com/image.png',
        broadcasterType: 'affiliate',
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        csrfTokenHash: tokenHash,
        version: 1
      }

      const mockCookieStore = createMockCookieStore({
        get: vi.fn((name) => {
          if (name === COOKIE_NAMES.SESSION) {
            return { value: JSON.stringify(sessionData) }
          }
          if (name === COOKIE_NAMES.CSRF_TOKEN) {
            return { value: token }
          }
          return undefined
        }),
        set: vi.fn(),
      })
  
    mockCookies.mockResolvedValue(mockCookieStore as any)

      const request = new Request('https://example.com')
      const getSpy = vi.spyOn(request.headers, 'get').mockImplementation((name) => {
        if (name === 'origin') return null
        if (name === 'referer') return 'https://malicious.com/page'
        return null
      })

      const result = await validateCSRFToken(request)

      expect(result.valid).toBe(false)
      expect(result.error).toBe(ERROR_MESSAGES.CSRF_TOKEN_INVALID)
      expect(mockLogger.warn).toHaveBeenCalledWith('CSRF validation failed: Referer header mismatch', {
        userId: 'user123',
        referer: 'https://malicious.com',
        expectedOrigin: 'https://example.com',
        endpoint: '/',
      })

      getSpy.mockRestore()
    })
  })

  describe('clearCSRFToken', () => {
    it('should remove CSRF token hash from session and increment version', async () => {
      const sessionData = {
        twitchUserId: 'user123',
        twitchUsername: 'testuser',
        twitchDisplayName: 'Test User',
        twitchProfileImageUrl: 'https://example.com/image.png',
        broadcasterType: 'affiliate',
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        csrfTokenHash: 'session-hash',
        version: 1
      }

      const mockCookieStore = createMockCookieStore({
        get: vi.fn((name) => {
          if (name === COOKIE_NAMES.SESSION) {
            return { value: JSON.stringify(sessionData) }
          }
          return undefined
        }),
        set: vi.fn(),
        delete: vi.fn(),
      })
  
    mockCookies.mockResolvedValue(mockCookieStore as any)

      await clearCSRFToken()

      // Session should be updated with incremented version and without csrfTokenHash
      expect(mockCookieStore.set).toHaveBeenCalledWith(
        COOKIE_NAMES.SESSION,
        expect.stringContaining('"version":2'),
        expect.any(Object)
      )
      expect(mockCookieStore.set).toHaveBeenCalledWith(
        COOKIE_NAMES.SESSION,
        expect.not.stringContaining('csrfTokenHash'),
        expect.any(Object)
      )
      // CSRF token cookie should be cleared with maxAge=0
      expect(mockCookieStore.set).toHaveBeenCalledWith(
        COOKIE_NAMES.CSRF_TOKEN,
        '',
        expect.objectContaining({ maxAge: 0 })
      )
      expect(mockLogger.info).toHaveBeenCalledWith('CSRF token cleared')
    })

    it('should handle case when CSRF token is not in session', async () => {
      const sessionData = {
        twitchUserId: 'user123',
        twitchUsername: 'testuser',
        twitchDisplayName: 'Test User',
        twitchProfileImageUrl: 'https://example.com/image.png',
        broadcasterType: 'affiliate',
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        version: 1
      }

      const mockCookieStore = createMockCookieStore({
        get: vi.fn((name) => {
          if (name === COOKIE_NAMES.SESSION) {
            return { value: JSON.stringify(sessionData) }
          }
          return undefined
        }),
        set: vi.fn(),
        delete: vi.fn(),
      })
  
    mockCookies.mockResolvedValue(mockCookieStore as any)

      await clearCSRFToken()

      expect(mockCookieStore.set).toHaveBeenCalledWith(
        COOKIE_NAMES.SESSION,
        expect.stringContaining('"version":2'),
        expect.any(Object)
      )
      // CSRF token cookie should still be cleared
      expect(mockCookieStore.set).toHaveBeenCalledWith(
        COOKIE_NAMES.CSRF_TOKEN,
        '',
        expect.objectContaining({ maxAge: 0 })
      )
    })

    it('should handle case when no session exists', async () => {
      const mockCookieStore = createMockCookieStore({
        get: vi.fn().mockReturnValue(undefined),
        set: vi.fn(),
        delete: vi.fn(),
      })
  
    mockCookies.mockResolvedValue(mockCookieStore as any)

      await clearCSRFToken()

      // Should still try to clear CSRF token cookie even without session
      expect(mockCookieStore.set).toHaveBeenCalledWith(
        COOKIE_NAMES.CSRF_TOKEN,
        '',
        expect.objectContaining({ maxAge: 0 })
      )
    })

    it('should keep the session cookie signed when clearing CSRF state', async () => {
      vi.stubEnv('SESSION_COOKIE_SECRET', 'test-secret-key-32-chars-abcdefgh')

      const sessionData = {
        twitchUserId: 'user123',
        twitchUsername: 'testuser',
        twitchDisplayName: 'Test User',
        twitchProfileImageUrl: 'https://example.com/image.png',
        broadcasterType: 'affiliate',
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        csrfTokenHash: 'session-hash',
        version: 1,
      }

      const signedSession = await signSession(JSON.stringify(sessionData))
      const mockCookieStore = createMockCookieStore({
        get: vi.fn((name) => {
          if (name === COOKIE_NAMES.SESSION) {
            return { value: signedSession }
          }
          return undefined
        }),
        set: vi.fn(),
        delete: vi.fn(),
      })

      mockCookies.mockResolvedValue(mockCookieStore as any)

      await clearCSRFToken()

      const updatedSessionValue = mockCookieStore.set.mock.calls[0][1]
      const verifiedPayload = await verifySession(updatedSessionValue)

      expect(updatedSessionValue).toContain('.')
      expect(verifiedPayload).toContain('"version":2')
      expect(verifiedPayload).not.toContain('csrfTokenHash')
    })
  })

  describe('hashIP', () => {
    it('should hash IP addresses', async () => {
      const ip = '192.168.1.1'
      const hash = await hashIP(ip)
      expect(typeof hash).toBe('string')
      expect(hash.length).toBe(8) // substring(0, 8)
    })

    it('should return unknown for null IP', async () => {
      const hash = await hashIP(null)
      expect(hash).toBe('unknown')
    })
  })

  describe('sanitizeURL', () => {
    it('should return pathname for valid URLs', () => {
      const url = 'https://example.com/api/test?param=value'
      const sanitized = sanitizeURL(url)
      expect(sanitized).toBe('/api/test')
    })

    it('should return invalid_url for invalid URLs', () => {
      const url = 'not-a-url'
      const sanitized = sanitizeURL(url)
      expect(sanitized).toBe('invalid_url')
    })
  })
})
