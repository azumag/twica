const encoder = new TextEncoder()

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function importHmacKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usage
  )
}

export async function sha256Hex(body: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(body)))
}

export async function createPublishSignature(
  secret: string,
  pathname: string,
  body: string,
  timestamp: string,
  nonce: string
): Promise<string> {
  const digest = await sha256Hex(body)
  const canonical = `${timestamp}\n${nonce}\n${pathname}\n${digest}`
  const key = await importHmacKey(secret, ['sign'])
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(canonical)))
}

function fromHex(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null
  const bytes = new Uint8Array(value.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

/**
 * WebCrypto performs the MAC comparison without a data-dependent JavaScript
 * string loop. The signed path prevents a valid body from being replayed to a
 * different room; timestamp and nonce are additionally checked by the Worker.
 */
export async function verifyPublishSignature(
  secret: string,
  pathname: string,
  body: string,
  timestamp: string,
  nonce: string,
  signature: string
): Promise<boolean> {
  const bytes = fromHex(signature)
  if (!bytes) return false
  const digest = await sha256Hex(body)
  const canonical = `${timestamp}\n${nonce}\n${pathname}\n${digest}`
  const key = await importHmacKey(secret, ['verify'])
  return crypto.subtle.verify('HMAC', key, bytes, encoder.encode(canonical))
}
