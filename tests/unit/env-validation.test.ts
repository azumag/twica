import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'

describe('requiredEnvVars', () => {
  it('contains NEXT_PUBLIC_APP_URL', async () => {
    const { requiredEnvVars } = await import('@/lib/env-validation')
    const found = requiredEnvVars.find(v => v.name === 'NEXT_PUBLIC_APP_URL')
    expect(found).toBeDefined()
    expect(found?.required).toBe(true)
  })

  it('contains TWITCH_EVENTSUB_SECRET', async () => {
    const { requiredEnvVars } = await import('@/lib/env-validation')
    const found = requiredEnvVars.find(v => v.name === 'TWITCH_EVENTSUB_SECRET')
    expect(found).toBeDefined()
    expect(found?.required).toBe(true)
  })

  it('contains all required Supabase variables', async () => {
    const { requiredEnvVars } = await import('@/lib/env-validation')
    const supabaseVars = requiredEnvVars.filter(v =>
      v.name.includes('SUPABASE') || v.name.includes('NEXT_PUBLIC_SUPABASE')
    )
    expect(supabaseVars.length).toBeGreaterThanOrEqual(3)
  })

  it('contains all required Twitch variables', async () => {
    const { requiredEnvVars } = await import('@/lib/env-validation')
    const twitchVars = requiredEnvVars.filter(v =>
      v.name.includes('TWITCH') || v.name.includes('NEXT_PUBLIC_TWITCH')
    )
    expect(twitchVars.length).toBeGreaterThanOrEqual(4)
  })
})

describe('validateEnvVars', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  beforeAll(() => {
    process.env.BLOB_READ_WRITE_TOKEN = 'test-token'
  })

  it('returns valid: true when all required vars are set', async () => {
    const { validateEnvVars } = await import('@/lib/env-validation')
    const result = validateEnvVars()
    expect(result.valid).toBe(true)
    expect(result.missing).toHaveLength(0)
  })

  it('returns valid: false when required var is missing', async () => {
    const { validateEnvVars } = await import('@/lib/env-validation')
    delete process.env.NEXT_PUBLIC_APP_URL
    const result = validateEnvVars()
    expect(result.valid).toBe(false)
    expect(result.missing).toContain('NEXT_PUBLIC_APP_URL')
  })
})

describe('getEnvVar', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns value when env var is set', async () => {
    const { getEnvVar } = await import('@/lib/env-validation')
    process.env.TEST_VAR = 'test-value'
    const result = getEnvVar('TEST_VAR', false)
    expect(result).toBe('test-value')
  })

  it('returns undefined when env var is not set and required is false', async () => {
    const { getEnvVar } = await import('@/lib/env-validation')
    delete process.env.TEST_VAR
    const result = getEnvVar('TEST_VAR', false)
    expect(result).toBeUndefined()
  })

  it('throws when env var is not set and required is true', async () => {
    const { getEnvVar } = await import('@/lib/env-validation')
    delete process.env.TEST_VAR
    expect(() => getEnvVar('TEST_VAR', true)).toThrow()
  })

  it('returns value when required is true and var is set', async () => {
    const { getEnvVar } = await import('@/lib/env-validation')
    process.env.TEST_VAR = 'required-value'
    const result = getEnvVar('TEST_VAR', true)
    expect(result).toBe('required-value')
  })
})
