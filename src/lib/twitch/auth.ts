import { getEnvVar } from '@/lib/env-validation'
import { logger } from '@/lib/logger'

const TWITCH_AUTH_URL = 'https://id.twitch.tv/oauth2/authorize'
const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token'
const TWITCH_API_URL = 'https://api.twitch.tv/helix'

export interface TwitchUser {
  id: string
  login: string
  display_name: string
  profile_image_url: string
  email?: string
  broadcaster_type: string // 'affiliate' | 'partner' | ''
}

export interface TwitchTokens {
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: string
  scope: string[]
}

export class TwitchOAuthTokenExchangeError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly errorBody: string,
    public readonly isInvalidAuthorizationCode: boolean
  ) {
    super(message)
    this.name = 'TwitchOAuthTokenExchangeError'
  }
}

function isInvalidAuthorizationCodeResponse(status: number, errorBody: string): boolean {
  return status === 400 && /invalid authorization code/i.test(errorBody)
}

export function isInvalidAuthorizationCodeError(error: unknown): boolean {
  return error instanceof TwitchOAuthTokenExchangeError && error.isInvalidAuthorizationCode
}

// デフォルトスコープ（ログイン時に必ず付与される基本スコープ）
// Default scopes that are always requested during login
export const AUTH_SCOPES = [
  'user:read:email',
  'channel:read:redemptions',
  'channel:manage:redemptions',
].join(' ')

// 追加スコープ定義（オプション機能用、再認証で取得）
// Additional scopes for optional features, obtained via re-authentication
export const ADDITIONAL_SCOPES = {
  // Twitchチャットへの書き込み権限（ガチャ結果のチャット通知に必要）
  // Permission to write to Twitch chat (required for gacha result announcements)
  CHAT_WRITE: 'user:write:chat',
} as const

/**
 * Twitch OAuth認証URLを生成
 * @param redirectUri - コールバックURL
 * @param state - CSRF防止用のstate値
 * @param additionalScopes - 追加で要求するスコープ（オプション機能用）
 * @param options - 追加オプション
 * @param options.forceVerify - force_verifyの明示的制御。
 *   trueまたは未指定(additionalScopes有り時): Twitchの同意画面を強制表示。
 *   false: 同意画面を強制しない（通常ログインで既存スコープを保持する場合に使用）。
 * @returns Twitch認証ページのURL
 */
export function getTwitchAuthUrl(
  redirectUri: string,
  state: string,
  additionalScopes?: string[],
  options?: { forceVerify?: boolean }
): string {
  const clientId = getEnvVar('NEXT_PUBLIC_TWITCH_CLIENT_ID', true)!

  // デフォルトスコープと追加スコープを結合
  // Combine default scopes with additional scopes
  let scopes = AUTH_SCOPES
  if (additionalScopes && additionalScopes.length > 0) {
    scopes = `${AUTH_SCOPES} ${additionalScopes.join(' ')}`
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes,
    state: state,
  })

  // force_verifyの制御:
  // - options.forceVerifyがfalseなら同意画面を強制しない（既存スコープ保持時）
  // - options.forceVerifyがtrueまたは未指定でadditionalScopesがある場合は強制表示
  // Control force_verify:
  // - If options.forceVerify is explicitly false, skip (preserving existing scopes on login)
  // - If true or unset with additionalScopes, force consent screen for new scope grants
  const shouldForceVerify = options?.forceVerify === false
    ? false
    : (additionalScopes && additionalScopes.length > 0)

  if (shouldForceVerify) {
    params.set('force_verify', 'true')
  }

  return `${TWITCH_AUTH_URL}?${params.toString()}`
}

export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string
): Promise<TwitchTokens> {
  const clientId = getEnvVar('NEXT_PUBLIC_TWITCH_CLIENT_ID', true)!
  const clientSecret = getEnvVar('TWITCH_CLIENT_SECRET', true)!

  const response = await fetch(TWITCH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    const invalidAuthorizationCode = isInvalidAuthorizationCodeResponse(response.status, errorBody)

    if (invalidAuthorizationCode) {
      // OAuth code is single-use and short-lived; retries/replays are expected client behavior.
      // Log as warning to avoid noisy issue generation.
      logger.warn('Token exchange rejected: invalid or expired authorization code', { status: response.status })
    } else {
      logger.error('Token exchange failed:', { status: response.status, errorBody })
    }
    // Twitch APIの拒否理由（コード期限切れ、redirect URI不一致等）をエラーメッセージに含める
    // 呼び出し元のhandleAuthError経由でSupabase/GitHub Issuesに詳細が記録される
    throw new TwitchOAuthTokenExchangeError(
      `Authentication failed: ${response.status} ${errorBody}`,
      response.status,
      errorBody,
      invalidAuthorizationCode
    )
  }

  return response.json()
}

export async function getTwitchUser(accessToken: string): Promise<TwitchUser> {
  const clientId = getEnvVar('NEXT_PUBLIC_TWITCH_CLIENT_ID', true)!

  const response = await fetch(`${TWITCH_API_URL}/users`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Client-Id': clientId,
    },
  })

  if (!response.ok) {
    const errorBody = await response.text()
    logger.error('Failed to get Twitch user:', { status: response.status, errorBody })
    // Twitch APIのエラー詳細をメッセージに含め、呼び出し元で原因を特定可能にする
    throw new Error(`Failed to get user information: ${response.status} ${errorBody}`)
  }

  const data = await response.json()
  return data.data[0]
}

export async function refreshTwitchToken(
  refreshToken: string
): Promise<TwitchTokens> {
  const clientId = getEnvVar('NEXT_PUBLIC_TWITCH_CLIENT_ID', true)!
  const clientSecret = getEnvVar('TWITCH_CLIENT_SECRET', true)!

  const response = await fetch(TWITCH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    logger.error('Token refresh failed:', { status: response.status, errorBody })
    // Twitch APIのエラー詳細をメッセージに含め、呼び出し元で原因を特定可能にする
    throw new Error(`Failed to refresh authentication token: ${response.status} ${errorBody}`)
  }

  return response.json()
}
