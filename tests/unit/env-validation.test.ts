import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

const originalEnv = { ...process.env }

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key]
    }
  }
  Object.assign(process.env, originalEnv)
}

beforeEach(() => {
  restoreEnv()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('requiredEnvVars', () => {
  it('keeps the non-database runtime requirements', async () => {
    const { requiredEnvVars } = await import('@/lib/env-validation')
    const names = requiredEnvVars.map((entry) => entry.name)

    expect(names).toContain('NEXT_PUBLIC_APP_URL')
    expect(names).toContain('NEXT_PUBLIC_TWITCH_CLIENT_ID')
    expect(names).toContain('TWITCH_CLIENT_SECRET')
    expect(names).toContain('TWITCH_EVENTSUB_SECRET')
    expect(names).toContain('CSRF_TOKEN_SALT')
  })

  it('contains only the current runtime requirements', async () => {
    const { requiredEnvVars, requiredEnvVarGroups } = await import('@/lib/env-validation')
    const serialized = JSON.stringify({ requiredEnvVars, requiredEnvVarGroups })

    expect(serialized).not.toContain('SUPABASE')
  })
})

describe('validateEnvVars', () => {
  it('returns valid when all current required vars are set', async () => {
    const { validateEnvVars } = await import('@/lib/env-validation')
    expect(validateEnvVars()).toEqual({ valid: true, missing: [] })
  })

  it('continues to reject a missing current requirement', async () => {
    const { validateEnvVars } = await import('@/lib/env-validation')
    delete process.env.NEXT_PUBLIC_APP_URL

    const result = validateEnvVars()
    expect(result.valid).toBe(false)
    expect(result.missing).toContain('NEXT_PUBLIC_APP_URL')
  })
})

describe('getEnvVar', () => {
  it('returns a trimmed value when set', async () => {
    const { getEnvVar } = await import('@/lib/env-validation')
    process.env.TEST_VAR = '  test-value\n'
    expect(getEnvVar('TEST_VAR')).toBe('test-value')
  })

  it('returns undefined for an optional missing variable', async () => {
    const { getEnvVar } = await import('@/lib/env-validation')
    delete process.env.TEST_VAR
    expect(getEnvVar('TEST_VAR')).toBeUndefined()
  })

  it('throws for a required missing variable', async () => {
    const { getEnvVar } = await import('@/lib/env-validation')
    delete process.env.TEST_VAR
    expect(() => getEnvVar('TEST_VAR', true)).toThrow(
      'Required environment variable TEST_VAR is not set'
    )
  })
})

describe('validateCSRFTokenSalt', () => {
  it('accepts at least 32 characters', async () => {
    const { validateCSRFTokenSalt } = await import('@/lib/env-validation')
    process.env.CSRF_TOKEN_SALT = 'a'.repeat(32)
    expect(validateCSRFTokenSalt()).toEqual({ valid: true })
  })

  it('rejects a missing salt', async () => {
    const { validateCSRFTokenSalt } = await import('@/lib/env-validation')
    delete process.env.CSRF_TOKEN_SALT
    expect(validateCSRFTokenSalt()).toEqual({
      valid: false,
      error: 'CSRF_TOKEN_SALT is not set',
    })
  })

  it('rejects a short salt', async () => {
    const { validateCSRFTokenSalt } = await import('@/lib/env-validation')
    process.env.CSRF_TOKEN_SALT = 'a'.repeat(31)
    expect(validateCSRFTokenSalt()).toEqual({
      valid: false,
      error: 'CSRF_TOKEN_SALT must be at least 32 characters for cryptographic security',
    })
  })
})
