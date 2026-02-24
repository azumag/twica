/**
 * Web Crypto API utilities for Cloudflare Workers/Edge Runtime compatibility
 * Cloudflare Workers/Edge Runtimeとの互換性のためのWeb Crypto APIユーティリティ
 *
 * Node.js cryptoモジュールの代わりにWeb Crypto APIを使用することで、
 * Cloudflare Pages/Workers環境でも動作可能になる
 */

/**
 * SHA-256ハッシュを生成（非同期、Web Crypto API使用）
 * Generate SHA-256 hash (async, using Web Crypto API)
 *
 * @param data - ハッシュ化するデータ
 * @returns 16進数文字列のハッシュ値
 */
export async function sha256(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * SHA-256ハッシュの先頭8文字を取得（ユーザープレフィックス用）
 * Get first 8 characters of SHA-256 hash (for user prefix)
 *
 * @param data - ハッシュ化するデータ
 * @returns 8文字のハッシュプレフィックス
 */
export async function sha256Prefix(data: string): Promise<string> {
  const hash = await sha256(data);
  return hash.substring(0, 8);
}

/**
 * ランダムなUUIDを生成（Web Crypto API使用）
 * Generate random UUID (using Web Crypto API)
 *
 * @returns UUID文字列
 */
export function randomUUID(): string {
  return crypto.randomUUID();
}

/**
 * ランダムなバイト列を生成（Web Crypto API使用）
 * Generate random bytes (using Web Crypto API)
 *
 * @param length - 生成するバイト数
 * @returns Uint8Array
 */
export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * ランダムなバイト列を16進数文字列として生成
 * Generate random bytes as hex string
 *
 * @param length - 生成するバイト数
 * @returns 16進数文字列
 */
export function randomBytesHex(length: number): string {
  const bytes = randomBytes(length);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * HMAC-SHA256署名を生成（非同期、Web Crypto API使用）
 * Generate HMAC-SHA256 signature (async, using Web Crypto API)
 *
 * @param secret - 署名に使用するシークレット
 * @param message - 署名対象のメッセージ
 * @returns 16進数文字列の署名
 */
export async function hmacSha256(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const messageData = encoder.encode(message);
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, messageData);
  const signatureArray = Array.from(new Uint8Array(signatureBuffer));
  return signatureArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 定数時間での文字列比較（タイミング攻撃対策）
 * Constant-time string comparison (timing attack prevention)
 *
 * @param a - 比較する文字列1
 * @param b - 比較する文字列2
 * @returns 文字列が等しい場合true
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}
