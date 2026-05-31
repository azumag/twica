import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('Twitch token encryption backfill script', () => {
  const script = readFileSync(
    resolve(__dirname, '../../scripts/backfill-twitch-token-encryption.mjs'),
    'utf8',
  )

  it('encrypts legacy users tokens into the dedicated table before clearing plaintext columns', () => {
    expect(script).toContain("from('users')")
    expect(script).toContain("from('twitch_oauth_tokens')")
    expect(script).toContain('encrypted_access_token')
    expect(script).toContain('encrypted_refresh_token')
    expect(script).toContain('TWITCH_TOKEN_ENCRYPTION_KEY')
    expect(script).toContain('twitch_access_token: null')
    expect(script).toContain('twitch_refresh_token: null')
  })
})
