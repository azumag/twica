import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetTokenEncryptionKeyCacheForTests,
  decryptTwitchToken,
  encryptTwitchToken,
  isEncryptedTwitchToken,
} from '@/lib/twitch/token-encryption'

// 32 バイト以上のテスト用秘密値（HKDF 入力）
// Test secret >= 32 bytes for HKDF IKM length validation.
const TEST_SECRET = 'unit-test-secret-key-with-sufficient-length-1234567890'
const TEST_USER_ID = 'twitch-user-12345'

describe('Twitch token encryption', () => {
  beforeEach(() => {
    process.env.TWITCH_TOKEN_ENCRYPTION_KEY = TEST_SECRET
    __resetTokenEncryptionKeyCacheForTests()
  })

  afterEach(() => {
    delete process.env.TWITCH_TOKEN_ENCRYPTION_KEY
    __resetTokenEncryptionKeyCacheForTests()
  })

  it('encrypts tokens without preserving plaintext and decrypts with matching AAD', async () => {
    const encrypted = await encryptTwitchToken('plain-access-token', TEST_USER_ID)

    expect(encrypted).toMatch(/^v1:/)
    expect(encrypted).not.toContain('plain-access-token')
    expect(isEncryptedTwitchToken(encrypted)).toBe(true)
    await expect(decryptTwitchToken(encrypted, TEST_USER_ID)).resolves.toBe('plain-access-token')
  })

  it('produces different ciphertexts for the same plaintext (random IV)', async () => {
    const a = await encryptTwitchToken('plain-access-token', TEST_USER_ID)
    const b = await encryptTwitchToken('plain-access-token', TEST_USER_ID)
    expect(a).not.toBe(b)
  })

  it('fails to decrypt when the AAD (twitch_user_id) does not match', async () => {
    const encrypted = await encryptTwitchToken('plain-access-token', TEST_USER_ID)

    // 別ユーザー ID で復号を試みると AES-GCM の認証タグ検証で失敗する。
    // これは行入れ替え攻撃や DB バグに対する防御の検証。
    // Decrypting with a different user_id must fail (cross-row substitution defense).
    await expect(decryptTwitchToken(encrypted, 'different-user')).rejects.toThrow()
  })

  it('fails to decrypt when the encryption key changes (HKDF derivation)', async () => {
    const encrypted = await encryptTwitchToken('plain-access-token', TEST_USER_ID)

    // 鍵秘密を変えると HKDF 出力も変わるため復号失敗する。
    // Changing the secret changes the HKDF-derived AES key; decryption must fail.
    process.env.TWITCH_TOKEN_ENCRYPTION_KEY = 'rotated-secret-key-with-sufficient-length-9876543210'
    __resetTokenEncryptionKeyCacheForTests()

    await expect(decryptTwitchToken(encrypted, TEST_USER_ID)).rejects.toThrow()
  })

  it('rejects secrets shorter than 32 bytes', async () => {
    process.env.TWITCH_TOKEN_ENCRYPTION_KEY = 'too-short'
    __resetTokenEncryptionKeyCacheForTests()

    await expect(encryptTwitchToken('plain', TEST_USER_ID)).rejects.toThrow(/at least 32 bytes/)
  })

  it('requires twitch_user_id as AAD on encrypt and decrypt', async () => {
    await expect(encryptTwitchToken('plain', '')).rejects.toThrow(/twitchUserId/)

    const encrypted = await encryptTwitchToken('plain', TEST_USER_ID)
    await expect(decryptTwitchToken(encrypted, '')).rejects.toThrow(/twitchUserId/)
  })

  it('rejects malformed encrypted token strings', async () => {
    await expect(decryptTwitchToken('not-a-valid-token', TEST_USER_ID)).rejects.toThrow(
      /Invalid encrypted Twitch token format/
    )
    await expect(decryptTwitchToken('v1:onlyone', TEST_USER_ID)).rejects.toThrow(
      /Invalid encrypted Twitch token format/
    )
  })

  it('caches the derived key across calls (idempotent under same secret)', async () => {
    // キャッシュ動作の間接検証: 同じ秘密で連続暗号化/復号が成功し続ける。
    // Indirect cache verification: repeated ops with the same secret stay valid.
    const a = await encryptTwitchToken('token-a', TEST_USER_ID)
    const b = await encryptTwitchToken('token-b', TEST_USER_ID)
    await expect(decryptTwitchToken(a, TEST_USER_ID)).resolves.toBe('token-a')
    await expect(decryptTwitchToken(b, TEST_USER_ID)).resolves.toBe('token-b')
  })
})
