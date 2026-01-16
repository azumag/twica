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

export const AUTH_SCOPES = [
  'user:read:email',
  'channel:read:redemptions',
  'channel:manage:redemptions',
].join(' ')

export function getTwitchAuthUrl(
  redirectUri: string,
  state: string
): string {
  const clientId = getEnvVar('NEXT_PUBLIC_TWITCH_CLIENT_ID', true)!
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: AUTH_SCOPES,
    state: state,
  })

  return `${TWITCH_AUTH_URL}?${params.toString()}`
}

export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string
): Promise<TwitchTokens> {
  const clientId = getEnvVar('TWITCH_CLIENT_ID', true)!
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
    logger.error('Token exchange failed:', { status: response.status, errorBody })
    throw new Error('Authentication failed')
  }

  return response.json()
}

export async function getTwitchUser(accessToken: string): Promise<TwitchUser> {
  const clientId = getEnvVar('TWITCH_CLIENT_ID', true)!

  const response = await fetch(`${TWITCH_API_URL}/users`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Client-Id': clientId,
    },
  })

  if (!response.ok) {
    const errorBody = await response.text()
    logger.error('Failed to get Twitch user:', { status: response.status, errorBody })
    throw new Error('Failed to get user information')
  }

  const data = await response.json()
  return data.data[0]
}

export async function refreshTwitchToken(
  refreshToken: string
): Promise<TwitchTokens> {
  const clientId = getEnvVar('TWITCH_CLIENT_ID', true)!
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
    throw new Error('Failed to refresh authentication token')
  }

  return response.json()
}
