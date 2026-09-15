import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SESSION_CONFIG,
  getCookieDomain,
  getDeleteCookieOptions,
  getSessionCookieOptions,
} from '@/lib/constants'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('session cookie options', () => {
  it('keeps cookies host-only by leaving domain unset', () => {
    expect(getCookieDomain()).toBeUndefined()
    expect(getSessionCookieOptions()).not.toHaveProperty('domain')
    expect(getDeleteCookieOptions()).not.toHaveProperty('domain')
  })

  it('keeps the session cookie lifetime and security defaults', () => {
    vi.stubEnv('NODE_ENV', 'test')

    expect(getSessionCookieOptions()).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_CONFIG.COOKIE_MAX_AGE_SECONDS,
    })
  })

  it('keeps delete cookies host-only and immediately expired', () => {
    vi.stubEnv('NODE_ENV', 'test')

    expect(getDeleteCookieOptions()).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    })
  })

  it('marks session and delete cookies secure in production', () => {
    vi.stubEnv('NODE_ENV', 'production')

    expect(getSessionCookieOptions().secure).toBe(true)
    expect(getDeleteCookieOptions().secure).toBe(true)
  })
})
