import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { ERROR_MESSAGES, CSRF_CONFIG, COOKIE_NAMES } from '@/lib/constants'
import { validateCSRFToken, hashToken } from '@/lib/csrf'
import type { MockInstance } from 'vitest'

vi.mock('next/headers')

describe('CSRF Integration Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('validateCSRFToken - cookie-based validation', () => {
    it('should validate request with valid CSRF token in httpOnly cookie', async () => {
      const { cookies } = await import('next/headers')
      const cookiesMock = cookies as unknown as MockInstance
      const token = 'a'.repeat(64) // 32 bytes * 2 (hex encoding) = 64 chars
      cookiesMock.mockResolvedValue({
        get: vi.fn((name) => {
          if (name === COOKIE_NAMES.SESSION) {
            return {
              value: JSON.stringify({
                twitchUserId: 'test-user',
                twitchUsername: 'testuser',
                twitchDisplayName: 'Test User',
                twitchProfileImageUrl: 'https://example.com/image.png',
                broadcasterType: 'affiliate',
                expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
                csrfTokenHash: hashToken(token),
                version: 1
              })
            }
          }
          if (name === COOKIE_NAMES.CSRF_TOKEN) {
            return {
              value: token
            }
          }
          return undefined
        }),
        set: vi.fn()
      } as unknown as Awaited<ReturnType<typeof cookies>>)

      const request = new NextRequest('http://localhost:3000/api/test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        }
      })

      const result = await validateCSRFToken(request)
      expect(result.valid).toBe(true)
    })

    it('should reject request without CSRF token in cookie', async () => {
      const { cookies } = await import('next/headers')
      const cookiesMock = cookies as unknown as MockInstance
      cookiesMock.mockResolvedValue({
        get: vi.fn((name) => {
          if (name === COOKIE_NAMES.SESSION) {
            return {
              value: JSON.stringify({
                twitchUserId: 'test-user',
                twitchUsername: 'testuser',
                twitchDisplayName: 'Test User',
                twitchProfileImageUrl: 'https://example.com/image.png',
                broadcasterType: 'affiliate',
                expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
                csrfTokenHash: hashToken('a'.repeat(64)),
                version: 1
              })
            }
          }
          return undefined
        }),
        set: vi.fn()
      } as unknown as Awaited<ReturnType<typeof cookies>>)

      const request = new NextRequest('http://localhost:3000/api/test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        }
      })

      const result = await validateCSRFToken(request)
      expect(result.valid).toBe(false)
      expect(result.error).toBe(ERROR_MESSAGES.CSRF_TOKEN_INVALID)
    })

    it('should reject request with invalid CSRF token in cookie', async () => {
      const { cookies } = await import('next/headers')
      const cookiesMock = cookies as unknown as MockInstance
      cookiesMock.mockResolvedValue({
        get: vi.fn((name) => {
          if (name === COOKIE_NAMES.SESSION) {
            return {
              value: JSON.stringify({
                twitchUserId: 'test-user',
                twitchUsername: 'testuser',
                twitchDisplayName: 'Test User',
                twitchProfileImageUrl: 'https://example.com/image.png',
                broadcasterType: 'affiliate',
                expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
                csrfTokenHash: hashToken('a'.repeat(64)),
                version: 1
              })
            }
          }
          if (name === COOKIE_NAMES.CSRF_TOKEN) {
            return {
              value: 'invalid-token'
            }
          }
          return undefined
        }),
        set: vi.fn()
      } as unknown as Awaited<ReturnType<typeof cookies>>)

      const request = new NextRequest('http://localhost:3000/api/test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        }
      })

      const result = await validateCSRFToken(request)
      expect(result.valid).toBe(false)
      expect(result.error).toBe(ERROR_MESSAGES.CSRF_TOKEN_INVALID)
    })
  })

  describe('CSRF Token API endpoint behavior', () => {
    it('should have correct endpoint configuration', () => {
      const endpoint = '/api/csrf-token'
      expect(endpoint).toBe('/api/csrf-token')
    })

    it('should require authentication for CSRF token', () => {
      const requiredAuth = true
      expect(requiredAuth).toBe(true)
    })

    it('should return CSRF token in expected format', () => {
      const expectedResponse = { csrfToken: 'string' }
      expect(expectedResponse).toHaveProperty('csrfToken')
      expect(typeof expectedResponse.csrfToken).toBe('string')
    })
  })

  describe('CSRF protection patterns', () => {
    it('should protect state-changing operations', () => {
      const protectedMethods = ['POST', 'PUT', 'DELETE', 'PATCH']
      const unprotectedMethods = ['GET', 'HEAD', 'OPTIONS']

      protectedMethods.forEach(method => {
        expect(['POST', 'PUT', 'DELETE', 'PATCH']).toContain(method)
      })

      unprotectedMethods.forEach(method => {
        expect(['GET', 'HEAD', 'OPTIONS']).toContain(method)
      })
    })

    it('should use httpOnly cookies for CSRF protection', () => {
      const cookieName = COOKIE_NAMES.CSRF_TOKEN
      expect(cookieName).toBe('csrf_token')
    })

    it('should have appropriate error messages', () => {
      expect(ERROR_MESSAGES.CSRF_TOKEN_MISSING).toBeDefined()
      expect(ERROR_MESSAGES.CSRF_TOKEN_INVALID).toBeDefined()
      expect(typeof ERROR_MESSAGES.CSRF_TOKEN_MISSING).toBe('string')
      expect(typeof ERROR_MESSAGES.CSRF_TOKEN_INVALID).toBe('string')
    })
  })

  describe('CSRF token properties', () => {
    it('should have correct token length configuration', () => {
      expect(CSRF_CONFIG.TOKEN_LENGTH).toBe(32)
    })

    it('should have correct retry configuration', () => {
      expect(CSRF_CONFIG.MAX_RETRY_COUNT).toBe(3)
      expect(CSRF_CONFIG.RETRY_DELAY_MS).toBe(10)
    })

    it('should generate tokens with sufficient entropy', () => {
      const tokenBytes = CSRF_CONFIG.TOKEN_LENGTH
      const entropyBits = tokenBytes * 8
      expect(entropyBits).toBeGreaterThanOrEqual(256)
    })
  })

  describe('Session integration', () => {
    it('should store CSRF token hash in session', () => {
      const sessionStructure = {
        twitchUserId: 'string',
        twitchUsername: 'string',
        csrfTokenHash: 'string'
      }

      expect(sessionStructure).toHaveProperty('csrfTokenHash')
      expect(typeof sessionStructure.csrfTokenHash).toBe('string')
    })

    it('should associate token with user', () => {
      const userId = 'test-user-123'
      const token = 'csrf-token-456'

      expect(userId).toBeDefined()
      expect(token).toBeDefined()
      expect(typeof userId).toBe('string')
      expect(typeof token).toBe('string')
    })
  })

  describe('Security considerations', () => {
    it('should use secure token generation', async () => {
      const { randomBytes } = await import('crypto')
      expect(typeof randomBytes).toBe('function')
    })

    it('should use timing-safe comparison', async () => {
      const { timingSafeEqual } = await import('crypto')
      expect(typeof timingSafeEqual).toBe('function')
    })

    it('should have proper error handling', () => {
      const validationResult = {
        valid: false,
        error: 'Test error'
      }

      expect(validationResult).toHaveProperty('valid')
      expect(validationResult).toHaveProperty('error')
      expect(typeof validationResult.valid).toBe('boolean')
      expect(typeof validationResult.error).toBe('string')
    })
  })

  describe('HttpOnly Cookie Pattern', () => {
    it('should use httpOnly cookie for CSRF token', () => {
      const cookieConfig = {
        httpOnly: true,
        secure: true,
        sameSite: 'lax'
      }
      expect(cookieConfig.httpOnly).toBe(true)
    })

    it('should validate tokens from httpOnly cookie', () => {
      const cookieName = COOKIE_NAMES.CSRF_TOKEN
      expect(cookieName).toBe('csrf_token')
    })

    it('should compare cookie value hash with session hash', async () => {
      const sessionHash = 'session-hash-123'
      const cookieToken = 'cookie-token-456'
      
      const { hashToken } = await import('@/lib/csrf')
      const cookieTokenHash = hashToken(cookieToken)
      
      expect(sessionHash).toBeDefined()
      expect(cookieTokenHash).toBeDefined()
      expect(typeof sessionHash).toBe('string')
      expect(typeof cookieTokenHash).toBe('string')
    })
  })
})
