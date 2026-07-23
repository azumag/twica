import { constantTimeEqual, hmacSha256 } from './crypto-utils'
import { logger } from './logger'

export interface SessionPayload {
  twitchUserId: string
  twitchUsername: string
  twitchDisplayName: string
  twitchProfileImageUrl: string
  broadcasterType: string // 'affiliate' | 'partner' | ''
  expiresAt: number // Unix timestamp (milliseconds)
  csrfTokenHash?: string
  version: number // Optimistic locking
  // #788: 非Affiliateユーザーがtwica配信者機能を明示的に有効化したかのセッションミラー。
  // DBが正本、これはアクセス判定用の高速な署名済みミラー。後方互換のためoptional。
  // 未定義の旧Cookieはfalse相当として扱う（canUseStreamerFeatures参照）。
  channelPointsEnabled?: boolean
}

interface VerifySessionOptions {
  allowUnsignedLegacy?: boolean
}

const SESSION_SIGNATURE_PATTERN = /^[a-f0-9]{64}$/

function splitSignedSession(cookieValue: string): { payload: string; signature: string } | null {
  const lastDot = cookieValue.lastIndexOf('.')
  if (lastDot === -1) {
    return null
  }

  const signature = cookieValue.substring(lastDot + 1)
  if (!SESSION_SIGNATURE_PATTERN.test(signature)) {
    return null
  }

  return {
    payload: cookieValue.substring(0, lastDot),
    signature,
  }
}

export function parseSession(raw: string): SessionPayload {
  try {
    const parsed = JSON.parse(raw)

    const requiredFields = [
      'twitchUserId',
      'twitchUsername',
      'twitchDisplayName',
      'twitchProfileImageUrl',
      'broadcasterType',
      'expiresAt',
      'version',
    ] as const

    for (const field of requiredFields) {
      if (parsed[field] === undefined || parsed[field] === null) {
        throw new Error(`Invalid session: missing required field '${field}'`)
      }
    }

    if (typeof parsed.twitchUserId !== 'string') {
      throw new Error('Invalid session: twitchUserId must be a string')
    }
    if (typeof parsed.twitchUsername !== 'string') {
      throw new Error('Invalid session: twitchUsername must be a string')
    }
    if (typeof parsed.twitchDisplayName !== 'string') {
      throw new Error('Invalid session: twitchDisplayName must be a string')
    }
    if (typeof parsed.twitchProfileImageUrl !== 'string') {
      throw new Error('Invalid session: twitchProfileImageUrl must be a string')
    }
    if (typeof parsed.broadcasterType !== 'string') {
      throw new Error('Invalid session: broadcasterType must be a string')
    }
    if (typeof parsed.expiresAt !== 'number') {
      throw new Error('Invalid session: expiresAt must be a number')
    }
    if (typeof parsed.version !== 'number') {
      throw new Error('Invalid session: version must be a number')
    }
    if (!Number.isInteger(parsed.version)) {
      throw new Error('Invalid session: version must be an integer')
    }
    if (parsed.version < 1) {
      throw new Error('Invalid session: version must be greater than or equal to 1')
    }
    if (parsed.version > Number.MAX_SAFE_INTEGER) {
      throw new Error('Invalid session: version exceeds maximum safe integer value')
    }
    // channelPointsEnabledはoptional（旧Cookieには存在しない）。存在する場合のみ型検証する。
    if (parsed.channelPointsEnabled !== undefined && typeof parsed.channelPointsEnabled !== 'boolean') {
      throw new Error('Invalid session: channelPointsEnabled must be a boolean')
    }

    return parsed as SessionPayload
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Invalid session format: ${error.message}`)
    }
    throw new Error('Invalid session format')
  }
}

/**
 * Sign session payload with HMAC-SHA256.
 *
 * Format: {JSON_payload}.{hex_signature}
 */
export async function signSession(payload: string): Promise<string> {
  const secret = process.env.SESSION_COOKIE_SECRET
  if (!secret) {
    logger.warn('[Session] SESSION_COOKIE_SECRET not set - session cookie is unsigned. Set this env var to enable tamper protection.')
    return payload
  }

  const signature = await hmacSha256(secret, payload)
  return `${payload}.${signature}`
}

/**
 * Verify signed session cookie and return the raw JSON payload.
 *
 * When allowUnsignedLegacy is true, unsigned legacy cookies are accepted so the
 * app can preserve scope-restore behavior during the migration window.
 */
export async function verifySession(
  cookieValue: string,
  options: VerifySessionOptions = {}
): Promise<string> {
  const split = splitSignedSession(cookieValue)
  const secret = process.env.SESSION_COOKIE_SECRET

  if (!secret) {
    if (split) {
      logger.warn('[Session] SESSION_COOKIE_SECRET not set - rejecting signed session cookie without verification.')
      throw new Error('Session cookie cannot be verified without SESSION_COOKIE_SECRET')
    }
    return cookieValue
  }

  if (!split) {
    if (options.allowUnsignedLegacy) {
      return cookieValue
    }

    logger.warn('[Session] Session cookie has no signature - rejecting. User must re-login.')
    throw new Error('Session cookie is not signed')
  }

  const expectedSig = await hmacSha256(secret, split.payload)
  if (!constantTimeEqual(split.signature, expectedSig)) {
    logger.warn('[Session] Session cookie signature mismatch - possible tampering detected.')
    throw new Error('Session cookie signature invalid')
  }

  return split.payload
}
