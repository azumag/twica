import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseSession, canUseStreamerFeatures, signSession, verifySession, Session } from '@/lib/session'

// session.ts が server-only logger を参照しても、payload parser の単体テストへ
// 永続化副作用を持ち込まないため同じ server-only entry point を mock する。
vi.mock('@/lib/logger.server', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

describe('parseSession', () => {
  it('should parse valid session data', () => {
    const validSession = {
      twitchUserId: '12345',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/image.png',
      broadcasterType: 'affiliate',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: 1
    }

    const session = parseSession(JSON.stringify(validSession))
    expect(session).toEqual(validSession)
  })

  it('should throw error if session is not valid JSON', () => {
    expect(() => parseSession('invalid json')).toThrow('Invalid session format')
  })

  it('should throw error if required field is missing', () => {
    const invalidSession = {
      twitchUserId: '12345',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/image.png',
      broadcasterType: 'affiliate',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    }

    expect(() => parseSession(JSON.stringify(invalidSession))).toThrow('missing required field')
  })

  it('should throw error if twitchUserId is not a string', () => {
    const invalidSession = {
      twitchUserId: 12345,
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/image.png',
      broadcasterType: 'affiliate',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: 1
    }

    expect(() => parseSession(JSON.stringify(invalidSession))).toThrow('twitchUserId must be a string')
  })

  it('should throw error if expiresAt is not a number', () => {
    const invalidSession = {
      twitchUserId: '12345',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/image.png',
      broadcasterType: 'affiliate',
      expiresAt: 'invalid',
      version: 1
    }

    expect(() => parseSession(JSON.stringify(invalidSession))).toThrow('expiresAt must be a number')
  })

  it('should throw error if version is not a number', () => {
    const invalidSession = {
      twitchUserId: '12345',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/image.png',
      broadcasterType: 'affiliate',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: 'invalid'
    }

    expect(() => parseSession(JSON.stringify(invalidSession))).toThrow('version must be a number')
  })

  it('should throw error if version is not an integer', () => {
    const invalidSession = {
      twitchUserId: '12345',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/image.png',
      broadcasterType: 'affiliate',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: 1.5
    }

    expect(() => parseSession(JSON.stringify(invalidSession))).toThrow('version must be an integer')
  })

  it('should throw error if version is zero', () => {
    const invalidSession = {
      twitchUserId: '12345',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/image.png',
      broadcasterType: 'affiliate',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: 0
    }

    expect(() => parseSession(JSON.stringify(invalidSession))).toThrow('version must be greater than or equal to 1')
  })

  it('should throw error if version is negative', () => {
    const invalidSession = {
      twitchUserId: '12345',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/image.png',
      broadcasterType: 'affiliate',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: -1
    }

    expect(() => parseSession(JSON.stringify(invalidSession))).toThrow('version must be greater than or equal to 1')
  })

  it('should throw error if version exceeds MAX_SAFE_INTEGER', () => {
    const invalidSession = {
      twitchUserId: '12345',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/image.png',
      broadcasterType: 'affiliate',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: Number.MAX_SAFE_INTEGER + 1
    }

    expect(() => parseSession(JSON.stringify(invalidSession))).toThrow('version exceeds maximum safe integer value')
  })

  it('should accept version equal to 1', () => {
    const validSession = {
      twitchUserId: '12345',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/image.png',
      broadcasterType: 'affiliate',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: 1
    }

    const session = parseSession(JSON.stringify(validSession))
    expect(session.version).toBe(1)
  })

  it('should accept version equal to MAX_SAFE_INTEGER', () => {
    const validSession = {
      twitchUserId: '12345',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/image.png',
      broadcasterType: 'affiliate',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: Number.MAX_SAFE_INTEGER
    }

    const session = parseSession(JSON.stringify(validSession))
    expect(session.version).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('should parse successfully when channelPointsEnabled is absent (legacy cookie) and leave it undefined', () => {
    const legacySession = {
      twitchUserId: '12345',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/image.png',
      broadcasterType: 'affiliate',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: 1
    }

    const session = parseSession(JSON.stringify(legacySession))
    expect(session.channelPointsEnabled).toBeUndefined()
  })

  it('should preserve channelPointsEnabled: true', () => {
    const validSession = {
      twitchUserId: '12345',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/image.png',
      broadcasterType: '',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: 1,
      channelPointsEnabled: true
    }

    const session = parseSession(JSON.stringify(validSession))
    expect(session.channelPointsEnabled).toBe(true)
  })

  it('should preserve channelPointsEnabled: false', () => {
    const validSession = {
      twitchUserId: '12345',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/image.png',
      broadcasterType: '',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: 1,
      channelPointsEnabled: false
    }

    const session = parseSession(JSON.stringify(validSession))
    expect(session.channelPointsEnabled).toBe(false)
  })

  it('should throw error if channelPointsEnabled is a string instead of a boolean', () => {
    const invalidSession = {
      twitchUserId: '12345',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/image.png',
      broadcasterType: '',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: 1,
      channelPointsEnabled: 'true'
    }

    expect(() => parseSession(JSON.stringify(invalidSession))).toThrow('channelPointsEnabled must be a boolean')
  })

  it('should throw error if channelPointsEnabled is a number instead of a boolean', () => {
    const invalidSession = {
      twitchUserId: '12345',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/image.png',
      broadcasterType: '',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: 1,
      channelPointsEnabled: 1
    }

    expect(() => parseSession(JSON.stringify(invalidSession))).toThrow('channelPointsEnabled must be a boolean')
  })

  it('should throw error if channelPointsEnabled is null', () => {
    const invalidSession = {
      twitchUserId: '12345',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/image.png',
      broadcasterType: '',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: 1,
      channelPointsEnabled: null
    }

    expect(() => parseSession(JSON.stringify(invalidSession))).toThrow('channelPointsEnabled must be a boolean')
  })
})

describe('canUseStreamerFeatures', () => {
  it('should return true for affiliate broadcaster', () => {
    const session: Session = {
      twitchUserId: '12345',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/image.png',
      broadcasterType: 'affiliate',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: 1
    }

    expect(canUseStreamerFeatures(session)).toBe(true)
  })

  it('should return true for partner broadcaster', () => {
    const session: Session = {
      twitchUserId: '12345',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/image.png',
      broadcasterType: 'partner',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: 1
    }

    expect(canUseStreamerFeatures(session)).toBe(true)
  })

  it('should return false for non-broadcaster', () => {
    const session: Session = {
      twitchUserId: '12345',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/image.png',
      broadcasterType: '',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: 1
    }

    expect(canUseStreamerFeatures(session)).toBe(false)
  })

  it('should return false for null session', () => {
    expect(canUseStreamerFeatures(null)).toBe(false)
  })

  it('should return true for affiliate broadcaster even when channelPointsEnabled is false', () => {
    const session: Session = {
      twitchUserId: '12345',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/image.png',
      broadcasterType: 'affiliate',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: 1,
      channelPointsEnabled: false
    }

    expect(canUseStreamerFeatures(session)).toBe(true)
  })

  it('should return true for partner broadcaster even when channelPointsEnabled is false', () => {
    const session: Session = {
      twitchUserId: '12345',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/image.png',
      broadcasterType: 'partner',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: 1,
      channelPointsEnabled: false
    }

    expect(canUseStreamerFeatures(session)).toBe(true)
  })

  it('should return true for non-affiliate broadcaster who explicitly opted in via channelPointsEnabled', () => {
    const session: Session = {
      twitchUserId: '12345',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/image.png',
      broadcasterType: '',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: 1,
      channelPointsEnabled: true
    }

    expect(canUseStreamerFeatures(session)).toBe(true)
  })

  it('should return false for non-affiliate broadcaster with channelPointsEnabled explicitly false', () => {
    const session: Session = {
      twitchUserId: '12345',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/image.png',
      broadcasterType: '',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: 1,
      channelPointsEnabled: false
    }

    expect(canUseStreamerFeatures(session)).toBe(false)
  })

  it('should return false for non-affiliate broadcaster with channelPointsEnabled omitted (legacy session)', () => {
    const session: Session = {
      twitchUserId: '12345',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/image.png',
      broadcasterType: '',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: 1
    }

    expect(canUseStreamerFeatures(session)).toBe(false)
  })
})

describe('signSession / verifySession', () => {
  const originalSecret = process.env.SESSION_COOKIE_SECRET

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.SESSION_COOKIE_SECRET
    } else {
      process.env.SESSION_COOKIE_SECRET = originalSecret
    }
  })

  it('should return the original payload when SESSION_COOKIE_SECRET is not set', async () => {
    delete process.env.SESSION_COOKIE_SECRET

    const payload = '{"foo":"bar"}'
    const signed = await signSession(payload)

    expect(signed).toBe(payload)
  })

  it('should add a dot-delimited signature when SESSION_COOKIE_SECRET is set', async () => {
    process.env.SESSION_COOKIE_SECRET = 'test-secret-key-32-chars-abcdefgh'

    const payload = '{"foo":"bar"}'
    const signed = await signSession(payload)

    expect(signed).toContain('.')
    expect(await verifySession(signed)).toBe(payload)
  })

  it('should reject unsigned legacy cookies by default when SESSION_COOKIE_SECRET is set', async () => {
    process.env.SESSION_COOKIE_SECRET = 'test-secret-key-32-chars-abcdefgh'

    await expect(verifySession('{"foo":"bar"}')).rejects.toThrow('Session cookie is not signed')
  })

  it('should allow unsigned legacy cookies when explicitly requested', async () => {
    process.env.SESSION_COOKIE_SECRET = 'test-secret-key-32-chars-abcdefgh'

    await expect(
      verifySession('{"foo":"bar"}', { allowUnsignedLegacy: true })
    ).resolves.toBe('{"foo":"bar"}')
  })

  it('should reject signed-looking cookies when SESSION_COOKIE_SECRET is not set', async () => {
    delete process.env.SESSION_COOKIE_SECRET

    const payload = '{"foo":"bar"}'
    const signedLooking = `${payload}.${'a'.repeat(64)}`

    await expect(verifySession(signedLooking)).rejects.toThrow(
      'Session cookie cannot be verified without SESSION_COOKIE_SECRET'
    )
  })

  it('should reject tampered signed cookies', async () => {
    process.env.SESSION_COOKIE_SECRET = 'test-secret-key-32-chars-abcdefgh'

    const payload = '{"foo":"bar"}'
    const signed = await signSession(payload)
    const tampered = signed.replace(/.$/, signed.endsWith('a') ? 'b' : 'a')

    await expect(verifySession(tampered)).rejects.toThrow('Session cookie signature invalid')
  })

  it('should treat unsigned payloads containing dots as legacy cookies', async () => {
    process.env.SESSION_COOKIE_SECRET = 'test-secret-key-32-chars-abcdefgh'

    const payload = JSON.stringify({
      twitchProfileImageUrl: 'https://example.com/image.png',
    })

    await expect(
      verifySession(payload, { allowUnsignedLegacy: true })
    ).resolves.toBe(payload)
  })
})
