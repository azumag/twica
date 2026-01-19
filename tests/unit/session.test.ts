import { describe, it, expect } from 'vitest'
import { parseSession, canUseStreamerFeatures, Session } from '@/lib/session'

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
      // version is missing
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
})
