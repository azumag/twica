import { describe, expect, it } from 'vitest'
import {
  constantTimeEqual,
  hmacSha256,
  randomBytes,
  randomBytesHex,
  randomUUID,
  sha256,
  sha256Prefix,
} from '@/lib/crypto-utils'

describe('crypto-utils', () => {
  it('SHA-256と8文字prefixを既知ベクトルで固定する', async () => {
    const hash = await sha256('abc')

    expect(hash).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(await sha256Prefix('abc')).toBe('ba7816bf')
  })

  it('HMAC-SHA256を既知ベクトルで固定する', async () => {
    const signature = await hmacSha256(
      'key',
      'The quick brown fox jumps over the lazy dog',
    )

    expect(signature).toBe(
      'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    )
  })

  it('constantTimeEqualは一致・不一致・長さ不一致を判定する', () => {
    expect(constantTimeEqual('same-value', 'same-value')).toBe(true)
    expect(constantTimeEqual('same-value', 'same-valuf')).toBe(false)
    expect(constantTimeEqual('short', 'longer')).toBe(false)
    expect(constantTimeEqual('', '')).toBe(true)
  })

  it('random helperは要求した長さと公開形式を維持する', () => {
    const bytes = randomBytes(16)
    const hex = randomBytesHex(16)
    const uuid = randomUUID()

    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes).toHaveLength(16)
    expect(hex).toMatch(/^[0-9a-f]{32}$/)
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
  })
})
