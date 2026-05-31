const ENCRYPTED_TOKEN_PREFIX = 'v1'
const IV_LENGTH = 12

// HKDF info パラメータ。ドメイン分離用にバージョン付き。
// 将来的にスキーマ変更時は v2 等にバンプし、復号フォールバックで対応する。
// HKDF info parameter for domain separation (versioned). Bump to v2 on schema change.
const HKDF_INFO = 'twitch-oauth-token-v1'

// 鍵秘密の最小バイト長（鍵推測耐性のため）
// Minimum secret bytes to provide adequate brute-force resistance.
const MIN_SECRET_BYTES = 32

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

function getEncryptionSecret(): string {
  const secret = process.env.TWITCH_TOKEN_ENCRYPTION_KEY?.trim()

  if (!secret) {
    throw new Error('TWITCH_TOKEN_ENCRYPTION_KEY is not set')
  }

  // 長さチェック: HKDF の入力鍵材料として最低限のエントロピーを担保。
  // 推奨: `openssl rand -base64 32` などで生成した 32 バイト以上のランダム値。
  // Length check: ensures sufficient entropy for HKDF IKM.
  // Recommended: 32+ random bytes generated via `openssl rand -base64 32`.
  if (textEncoder.encode(secret).byteLength < MIN_SECRET_BYTES) {
    throw new Error(
      `TWITCH_TOKEN_ENCRYPTION_KEY must be at least ${MIN_SECRET_BYTES} bytes (recommend 32 random bytes encoded as base64)`
    )
  }

  return secret
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer
}

// モジュールレベル鍵キャッシュ。Cloudflare Workers の各リクエストで HKDF を
// 走らせるコストを削減する（鍵秘密はプロセス起動中に変わらない前提）。
// テストで秘密値を切り替える場合は __resetTokenEncryptionKeyCacheForTests を呼ぶ。
// Module-level key cache to avoid HKDF cost on each Workers request
// (secret is assumed stable for process lifetime). Tests rotating the secret
// must call __resetTokenEncryptionKeyCacheForTests.
let cachedKeyPromise: Promise<CryptoKey> | null = null
let cachedKeySecret: string | null = null

async function deriveTokenEncryptionKey(secret: string): Promise<CryptoKey> {
  // HKDF (RFC 5869) で AES-GCM 鍵を導出。
  // - IKM: 環境変数の秘密値（ユーザー指定文字列）
  // - salt: 空（秘密が高エントロピーであれば salt は省略可能。RFC 5869 §3.1）
  // - info: バージョン付きラベル。将来の鍵ローテ/プロトコル変更で分離可能
  // 単純な SHA-256(secret) では鍵ストレッチが行われず、また異なる用途で
  // 同じ鍵が再利用される危険があるため HKDF を使う。
  // HKDF (RFC 5869) for AES-GCM key derivation.
  // Salt is empty (RFC 5869 §3.1 allows this when IKM has high entropy);
  // info provides domain separation for future key rotation/protocol changes.
  // Plain SHA-256(secret) lacks stretching and risks key reuse across purposes.
  const ikm = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    'HKDF',
    false,
    ['deriveKey']
  )

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: textEncoder.encode(HKDF_INFO),
    },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

async function getTokenEncryptionKey(): Promise<CryptoKey> {
  const secret = getEncryptionSecret()

  // 秘密値が変わったらキャッシュ無効化（テスト時の切替対応）
  // Invalidate cache if secret changed (supports test-time secret rotation).
  if (cachedKeyPromise && cachedKeySecret === secret) {
    return cachedKeyPromise
  }

  cachedKeySecret = secret
  cachedKeyPromise = deriveTokenEncryptionKey(secret).catch((error) => {
    // 失敗したキャッシュは即座にクリアして次回再試行可能にする
    // Clear failed cache so next call can retry.
    cachedKeyPromise = null
    cachedKeySecret = null
    throw error
  })

  return cachedKeyPromise
}

/**
 * テスト専用: 鍵キャッシュをリセット
 * Test-only: reset the cached key promise.
 */
export function __resetTokenEncryptionKeyCacheForTests(): void {
  cachedKeyPromise = null
  cachedKeySecret = null
}

export function isEncryptedTwitchToken(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(`${ENCRYPTED_TOKEN_PREFIX}:`)
}

/**
 * Twitch OAuth トークンを暗号化する。
 * @param plainToken 平文トークン
 * @param twitchUserId AAD として束縛する Twitch ユーザー ID。
 *   AAD を付けることで、別ユーザー行に暗号文をコピーされても復号失敗となり、
 *   行入れ替え型の攻撃や DB バグに対する追加の防御となる。
 * Encrypts a Twitch OAuth token. The twitch_user_id is bound as AAD so that
 * cross-row ciphertext substitution (DB tampering, row swap bugs) fails to decrypt.
 */
export async function encryptTwitchToken(plainToken: string, twitchUserId: string): Promise<string> {
  if (!twitchUserId) {
    throw new Error('twitchUserId is required as AAD for token encryption')
  }

  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
  const key = await getTokenEncryptionKey()
  const cipherText = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: textEncoder.encode(twitchUserId) },
    key,
    textEncoder.encode(plainToken)
  )

  return [
    ENCRYPTED_TOKEN_PREFIX,
    bytesToBase64Url(iv),
    bytesToBase64Url(new Uint8Array(cipherText)),
  ].join(':')
}

/**
 * Twitch OAuth トークンを復号する。
 * @param encryptedToken `v1:<iv>:<ct>` 形式の暗号文
 * @param twitchUserId 暗号化時に AAD として渡した Twitch ユーザー ID。
 *   不一致の場合は AES-GCM 認証失敗で例外を投げる。
 * Decrypts a Twitch OAuth token. The same twitch_user_id used as AAD on encrypt
 * must be supplied; mismatch yields AES-GCM auth failure.
 */
export async function decryptTwitchToken(encryptedToken: string, twitchUserId: string): Promise<string> {
  if (!twitchUserId) {
    throw new Error('twitchUserId is required as AAD for token decryption')
  }

  const [version, encodedIv, encodedCipherText] = encryptedToken.split(':')

  if (version !== ENCRYPTED_TOKEN_PREFIX || !encodedIv || !encodedCipherText) {
    throw new Error('Invalid encrypted Twitch token format')
  }

  const key = await getTokenEncryptionKey()
  const iv = base64UrlToBytes(encodedIv)
  const cipherText = base64UrlToBytes(encodedCipherText)
  const plainText = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: bytesToArrayBuffer(iv),
      additionalData: textEncoder.encode(twitchUserId),
    },
    key,
    bytesToArrayBuffer(cipherText)
  )

  return textDecoder.decode(plainText)
}
