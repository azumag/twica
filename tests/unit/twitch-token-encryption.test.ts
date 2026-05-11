import { describe, expect, it } from 'vitest'
import { decryptTwitchToken, encryptTwitchToken, isEncryptedTwitchToken } from '@/lib/twitch/token-encryption'

describe('Twitch token encryption', () => {
  it('encrypts tokens without preserving plaintext and decrypts them with the app secret', async () => {
    const encrypted = await encryptTwitchToken('plain-access-token')

    expect(encrypted).toMatch(/^v1:/)
    expect(encrypted).not.toContain('plain-access-token')
    expect(isEncryptedTwitchToken(encrypted)).toBe(true)
    await expect(decryptTwitchToken(encrypted)).resolves.toBe('plain-access-token')
  })
})
