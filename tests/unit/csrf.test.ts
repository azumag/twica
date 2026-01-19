import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cookies } from 'next/headers'
import { randomBytes, timingSafeEqual, createHash } from 'crypto'
import { logger } from '@/lib/logger'

import { COOKIE_NAMES, CSRF_CONFIG, ERROR_MESSAGES } from '@/lib/constants'
import { setCSRFToken, validateCSRFToken, hashToken, clearCSRFToken, hashIP, sanitizeURL } from '@/lib/csrf'
import type { MockInstance } from 'vitest'

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
      ...actual.CSRF_CONFIG,
      ALLOWED_ORIGINS: ['https://example.com', 'http://localhost:3000'],
    },
  }
})

vi.mock('next/headers')
vi.mock('crypto')
vi.mock('@/lib/logger')
vi.mock('@/lib/sentry/error-handler')

const mockCookies = vi.mocked(cookies) as unknown as MockInstance
const mockRandomBytes = vi.mocked(randomBytes) as unknown as ReturnType<typeof vi.fn>
const mockTimingSafeEqual = vi.mocked(timingSafeEqual) as unknown as ReturnType<typeof vi.fn>
const mockCreateHash = vi.mocked(createHash) as unknown as ReturnType<typeof vi.fn>

const mockLogger = vi.mocked(logger)

describe('CSRF Protection', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    const mockCookieStore = {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
    }

    mockCookies.mockResolvedValue(mockCookieStore as unknown as MockCookieStore)
    mockRandomBytes.mockReturnValue(Buffer.from('a'.repeat(64), 'hex'))
    mockTimingSafeEqual.mockReturnValue(true)

    const mockHash = {
      update: vi.fn().mockReturnThis(),
      digest: vi.fn().mockReturnValue('mocked-hash'),
    }
    mockCreateHash.mockReturnValue(mockHash as unknown as ReturnType<typeof createHash>)
  })

  describe('hashToken', () => {
    it('should generate consistent hashes', () => {
      const token = 'test-token'
      const hash1 = hashToken(token)
      const hash2 = hashToken(token)
      expect(hash1).toBe(hash2)
      expect(hash1).toBe('mocked-hash')
    })

    it('should generate different hashes for different tokens', () => {
      const mockHash1 = {
        update: vi.fn().mockReturnThis(),
        digest: vi.fn().mockReturnValue('hash1'),
      }
      const mockHash2 = {
        update: vi.fn().mockReturnThis(),
        digest: vi.fn().mockReturnValue('hash2'),
      }
      mockCreateHash
        .mockReturnValueOnce(mockHash1 as unknown as ReturnType<typeof createHash>)
        .mockReturnValueOnce(mockHash2 as unknown as ReturnType<typeof createHash>)

      const hash1 = hashToken('token1')
      const hash2 = hashToken('token2')
      expect(hash1).not.toBe(hash2)
      expect(hash1).toBe('hash1')
      expect(hash2).toBe('hash2')
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

      const mockCookieStore = {
        get: vi.fn().mockReturnValue({ value: JSON.stringify(sessionData) }),
        set: vi.fn(),
      }
      mockCookies.mockResolvedValue(mockCookieStore as unknown as MockCookieStore)

      const token = await setCSRFToken()

      expect(token).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      expect(mockRandomBytes).toHaveBeenCalledWith(CSRF_CONFIG.TOKEN_LENGTH)

      expect(mockCookieStore.set).toHaveBeenCalledTimes(2)

      expect(mockCookieStore.set).toHaveBeenNthCalledWith(
        1,
        COOKIE_NAMES.SESSION,
        expect.stringContaining('"csrfTokenHash":"mocked-hash"'),
        expect.any(Object)
      )
      expect(mockCookieStore.set).toHaveBeenNthCalledWith(
        2,
        COOKIE_NAMES.CSRF_TOKEN,
        expect.any(String),
        expect.objectContaining({
          httpOnly: true,
          sameSite: 'strict',
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

      const mockCookieStore = {
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
      }
      mockCookies.mockResolvedValue(mockCookieStore as unknown as MockCookieStore)

      const token = await setCSRFToken()

      expect(token).toBe('existing-token')
      expect(mockRandomBytes).not.toHaveBeenCalled()
    })

    it('should throw error when no session found', async () => {
      const mockCookieStore = {
        get: vi.fn().mockReturnValue(undefined),
        set: vi.fn(),
      }
      mockCookies.mockResolvedValue(mockCookieStore as unknown as MockCookieStore)

      await expect(setCSRFToken()).rejects.toThrow('No session found')
    })
  })

  describe('validateCSRFToken', () => {
    it('should validate matching tokens from httpOnly cookie', async () => {
      const token = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      const tokenHash = 'mocked-hash'

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

      const mockCookieStore = {
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
      }
      mockCookies.mockResolvedValue(mockCookieStore as unknown as MockCookieStore)

      const request = new Request('https://example.com')

      const result = await validateCSRFToken(request)

      expect(result.valid).toBe(true)
      expect(mockTimingSafeEqual).toHaveBeenCalledWith(
        Buffer.from(tokenHash),
        Buffer.from('mocked-hash')
      )
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

      const mockCookieStore = {
        get: vi.fn((name) => {
          if (name === COOKIE_NAMES.SESSION) {
            return { value: JSON.stringify(sessionData) }
          }
          return undefined
        }),
        set: vi.fn(),
      }
      mockCookies.mockResolvedValue(mockCookieStore as unknown as MockCookieStore)

      const request = new Request('https://example.com')

      const result = await validateCSRFToken(request)

      expect(result.valid).toBe(false)
      expect(result.error).toBe(ERROR_MESSAGES.CSRF_TOKEN_INVALID)
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

      const mockCookieStore = {
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
      }
      mockCookies.mockResolvedValue(mockCookieStore as unknown as MockCookieStore)

      const request = new Request('https://example.com')

      const result = await validateCSRFToken(request)

      expect(result.valid).toBe(false)
      expect(result.error).toBe(ERROR_MESSAGES.CSRF_TOKEN_INVALID)
      expect(mockLogger.warn).toHaveBeenCalledWith('CSRF validation failed: Invalid token length', {
        userId: 'user123',
      })
    })

    it('should reject when no session found', async () => {
      const mockCookieStore = {
        get: vi.fn().mockReturnValue(undefined),
        set: vi.fn(),
      }
      mockCookies.mockResolvedValue(mockCookieStore as unknown as MockCookieStore)

      const request = new Request('https://example.com')

      const result = await validateCSRFToken(request)

      expect(result.valid).toBe(false)
      expect(result.error).toBe(ERROR_MESSAGES.CSRF_TOKEN_INVALID)
    })

    it('should accept valid origin header', async () => {
      vi.stubEnv('NODE_ENV', 'test')
      vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://example.com')

      const token = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      const tokenHash = 'mocked-hash'

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

      const mockCookieStore = {
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
      }
      mockCookies.mockResolvedValue(mockCookieStore as unknown as MockCookieStore)

      const request = new Request('https://example.com', {
        headers: { 'origin': 'https://example.com' }
      })

      const result = await validateCSRFToken(request)

      expect(result.valid).toBe(true)

      vi.unstubAllEnvs()
    })

    it('should reject invalid origin header', async () => {
      const token = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      const tokenHash = 'mocked-hash'

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

      const mockCookieStore = {
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
      }
      mockCookies.mockResolvedValue(mockCookieStore as unknown as MockCookieStore)

      const request = new Request('https://example.com', {
        headers: { 'origin': 'https://malicious.com' }
      })

      const result = await validateCSRFToken(request)

      expect(result.valid).toBe(false)
      expect(result.error).toBe(ERROR_MESSAGES.CSRF_TOKEN_INVALID)
      expect(mockLogger.warn).toHaveBeenCalledWith('CSRF validation failed: Origin header not in allowed list', {
        userId: 'user123',
        origin: 'https://malicious.com',
        allowLocalOrigins: false,
        allowedOrigins: expect.any(Array),
        endpoint: '/',
      })
    })

    it('should accept valid referer header when origin is missing', async () => {
      const token = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      const tokenHash = 'mocked-hash'

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

      const mockCookieStore = {
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
      }
      mockCookies.mockResolvedValue(mockCookieStore as unknown as MockCookieStore)

      const request = new Request('https://example.com/api/test', {
        headers: { 'referer': 'https://example.com/page' }
      })

      const result = await validateCSRFToken(request)

      expect(result.valid).toBe(true)
    })

    it('should reject invalid referer header when origin is missing', async () => {
      const token = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      const tokenHash = 'mocked-hash'

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

      const mockCookieStore = {
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
      }
      mockCookies.mockResolvedValue(mockCookieStore as unknown as MockCookieStore)

      const request = new Request('https://example.com', {
        headers: { 'referer': 'https://malicious.com/page' }
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

      const mockCookieStore = {
        get: vi.fn((name) => {
          if (name === COOKIE_NAMES.SESSION) {
            return { value: JSON.stringify(sessionData) }
          }
          return undefined
        }),
        set: vi.fn(),
        delete: vi.fn(),
      }
      mockCookies.mockResolvedValue(mockCookieStore as unknown as MockCookieStore)

      await clearCSRFToken()

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
      expect(mockCookieStore.delete).toHaveBeenCalledWith(COOKIE_NAMES.CSRF_TOKEN)
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

      const mockCookieStore = {
        get: vi.fn((name) => {
          if (name === COOKIE_NAMES.SESSION) {
            return { value: JSON.stringify(sessionData) }
          }
          return undefined
        }),
        set: vi.fn(),
        delete: vi.fn(),
      }
      mockCookies.mockResolvedValue(mockCookieStore as unknown as MockCookieStore)

      await clearCSRFToken()

      expect(mockCookieStore.set).toHaveBeenCalledWith(
        COOKIE_NAMES.SESSION,
        expect.stringContaining('"version":2'),
        expect.any(Object)
      )
      expect(mockCookieStore.delete).toHaveBeenCalledWith(COOKIE_NAMES.CSRF_TOKEN)
    })

    it('should handle case when no session exists', async () => {
      const mockCookieStore = {
        get: vi.fn().mockReturnValue(undefined),
        set: vi.fn(),
        delete: vi.fn(),
      }
      mockCookies.mockResolvedValue(mockCookieStore as unknown as MockCookieStore)

      await clearCSRFToken()

      expect(mockCookieStore.set).not.toHaveBeenCalled()
      expect(mockCookieStore.delete).not.toHaveBeenCalled()
    })
  })

  describe('hashIP', () => {
    it('should hash IP addresses', () => {
      const mockHash = {
        update: vi.fn().mockReturnThis(),
        digest: vi.fn().mockReturnValue('mocked-hash'),
      }
      mockCreateHash.mockReturnValue(mockHash as unknown as ReturnType<typeof createHash>)

      const ip = '192.168.1.1'
      const hash = hashIP(ip)
      expect(hash).toBe('mocked-h') // substring(0, 8) of 'mocked-hash'
    })

    it('should return unknown for null IP', () => {
      const hash = hashIP(null)
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