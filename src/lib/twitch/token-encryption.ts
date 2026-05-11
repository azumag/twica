const ENCRYPTED_TOKEN_PREFIX = 'v1'
const IV_LENGTH = 12

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

function getEncryptionSecret(): string {
  const secret = process.env.TWITCH_TOKEN_ENCRYPTION_KEY?.trim()

  if (!secret) {
    throw new Error('TWITCH_TOKEN_ENCRYPTION_KEY is not set')
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

async function getTokenEncryptionKey(): Promise<CryptoKey> {
  const keyMaterial = textEncoder.encode(getEncryptionSecret())
  const keyHash = await crypto.subtle.digest('SHA-256', keyMaterial)

  return crypto.subtle.importKey('raw', keyHash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export function isEncryptedTwitchToken(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(`${ENCRYPTED_TOKEN_PREFIX}:`)
}

export async function encryptTwitchToken(plainToken: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
  const key = await getTokenEncryptionKey()
  const cipherText = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    textEncoder.encode(plainToken)
  )

  return [
    ENCRYPTED_TOKEN_PREFIX,
    bytesToBase64Url(iv),
    bytesToBase64Url(new Uint8Array(cipherText)),
  ].join(':')
}

export async function decryptTwitchToken(encryptedToken: string): Promise<string> {
  const [version, encodedIv, encodedCipherText] = encryptedToken.split(':')

  if (version !== ENCRYPTED_TOKEN_PREFIX || !encodedIv || !encodedCipherText) {
    throw new Error('Invalid encrypted Twitch token format')
  }

  const key = await getTokenEncryptionKey()
  const iv = base64UrlToBytes(encodedIv)
  const cipherText = base64UrlToBytes(encodedCipherText)
  const plainText = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytesToArrayBuffer(iv) },
    key,
    bytesToArrayBuffer(cipherText)
  )

  return textDecoder.decode(plainText)
}
