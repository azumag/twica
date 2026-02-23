import { getEnvVar } from '@/lib/env-validation'
import { logger } from '@/lib/logger'

// Discord OAuth2 / API エンドポイント定数
// Discord OAuth2 / API endpoint constants
const DISCORD_AUTH_URL = 'https://discord.com/oauth2/authorize'
const DISCORD_TOKEN_URL = 'https://discord.com/api/v10/oauth2/token'
const DISCORD_API_URL = 'https://discord.com/api/v10'

// Discord連携で要求するスコープ:
// - identify: ユーザー基本情報（id, username, avatar）取得に必要
// - guilds.members.read: ギルドメンバー情報（ロール等）取得に必要（サブスク検証用）
// Scopes requested for Discord integration:
// - identify: required to fetch basic user info (id, username, avatar)
// - guilds.members.read: required to fetch guild member info (roles etc.) for subscription verification
export const DISCORD_SCOPES = 'identify guilds.members.read'

export interface DiscordTokens {
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: string
  scope: string
}

export interface DiscordUser {
  id: string
  username: string
  global_name: string | null
  avatar: string | null
}

export interface GuildMember {
  roles: string[]
  nick: string | null
  user?: DiscordUser
}

/**
 * Discord OAuth2 認証URLを生成する
 * スコープ: identify + guilds.members.read（サブスク検証に必要）
 *
 * Generate Discord OAuth2 authorization URL.
 * Scopes: identify + guilds.members.read (required for subscription verification)
 *
 * @param redirectUri - OAuthコールバックURL / OAuth callback URL
 * @param state - CSRF防止用のstate値 / CSRF prevention state value
 * @returns Discord認証ページのURL / Discord authorization page URL
 */
export function getDiscordAuthUrl(redirectUri: string, state: string): string {
  // DISCORD_CLIENT_ID はオプション機能のため required=false で取得
  // 関数呼び出し時にnullチェックし、未設定の場合はエラーを投げる
  // DISCORD_CLIENT_ID is fetched with required=false since Discord is optional
  // Null-check at call time and throw if not configured
  const clientId = getEnvVar('DISCORD_CLIENT_ID')
  if (!clientId) {
    throw new Error('DISCORD_CLIENT_ID is not configured. Discord integration is disabled.')
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: DISCORD_SCOPES,
    state: state,
  })

  return `${DISCORD_AUTH_URL}?${params.toString()}`
}

/**
 * 認証コードをアクセストークンに交換する
 * Discord OAuth2 Authorization Code Flow のトークン交換ステップ
 *
 * Exchange authorization code for access token.
 * Implements the token exchange step of Discord OAuth2 Authorization Code Flow.
 *
 * @param code - Discordから受け取った認証コード / Authorization code received from Discord
 * @param redirectUri - 認証時に使用したコールバックURL / Callback URL used during authorization
 * @returns DiscordTokens オブジェクト / DiscordTokens object
 */
export async function exchangeDiscordCode(code: string, redirectUri: string): Promise<DiscordTokens> {
  const clientId = getEnvVar('DISCORD_CLIENT_ID')
  const clientSecret = getEnvVar('DISCORD_CLIENT_SECRET')

  if (!clientId || !clientSecret) {
    throw new Error('DISCORD_CLIENT_ID or DISCORD_CLIENT_SECRET is not configured.')
  }

  const response = await fetch(DISCORD_TOKEN_URL, {
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
    logger.error('Discord token exchange failed:', { status: response.status, errorBody })
    // Discord APIの拒否理由（コード期限切れ、redirect URI不一致等）をエラーメッセージに含める
    // Include Discord API rejection reason (expired code, redirect URI mismatch, etc.)
    throw new Error(`Discord authentication failed: ${response.status} ${errorBody}`)
  }

  return response.json()
}

/**
 * Discordユーザー情報を取得する (GET /users/@me)
 * ユーザーのid, username, global_name, avatarを返す
 *
 * Fetch Discord user information (GET /users/@me).
 * Returns the user's id, username, global_name, and avatar.
 *
 * @param accessToken - Discordアクセストークン / Discord access token
 * @returns DiscordUser オブジェクト / DiscordUser object
 */
export async function getDiscordUser(accessToken: string): Promise<DiscordUser> {
  const response = await fetch(`${DISCORD_API_URL}/users/@me`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
    },
  })

  if (!response.ok) {
    const errorBody = await response.text()
    logger.error('Failed to get Discord user:', { status: response.status, errorBody })
    // Discord APIのエラー詳細をメッセージに含め、呼び出し元で原因を特定可能にする
    // Include Discord API error details for caller to identify the cause
    throw new Error(`Failed to get Discord user information: ${response.status} ${errorBody}`)
  }

  return response.json()
}

/**
 * ギルドメンバー情報を取得する (GET /users/@me/guilds/{guild.id}/member)
 * roles[] を含むレスポンスを返し、サブスクリプションロール検証に使用する
 *
 * Fetch guild member information (GET /users/@me/guilds/{guild.id}/member).
 * Returns response including roles[], used for subscription role verification.
 *
 * @param accessToken - Discordアクセストークン / Discord access token
 * @param guildId - 確認するDiscordサーバーのID / ID of the Discord server to check
 * @returns GuildMember オブジェクト（roles[]を含む） / GuildMember object (includes roles[])
 */
export async function getGuildMember(accessToken: string, guildId: string): Promise<GuildMember> {
  const response = await fetch(`${DISCORD_API_URL}/users/@me/guilds/${guildId}/member`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
    },
  })

  if (!response.ok) {
    const errorBody = await response.text()
    logger.error('Failed to get guild member:', { status: response.status, guildId, errorBody })
    // 404はギルド未参加を意味するため、呼び出し元で適切に処理すること
    // 404 means the user is not in the guild; caller should handle this appropriately
    throw new Error(`Failed to get guild member information: ${response.status} ${errorBody}`)
  }

  return response.json()
}

/**
 * Discordアクセストークンをリフレッシュする
 * トークン期限切れ時に自動的に呼び出される
 *
 * Refresh a Discord access token.
 * Called automatically when the token has expired.
 *
 * @param refreshToken - Discordリフレッシュトークン / Discord refresh token
 * @returns 新しい DiscordTokens オブジェクト / New DiscordTokens object
 */
export async function refreshDiscordToken(refreshToken: string): Promise<DiscordTokens> {
  const clientId = getEnvVar('DISCORD_CLIENT_ID')
  const clientSecret = getEnvVar('DISCORD_CLIENT_SECRET')

  if (!clientId || !clientSecret) {
    throw new Error('DISCORD_CLIENT_ID or DISCORD_CLIENT_SECRET is not configured.')
  }

  const response = await fetch(DISCORD_TOKEN_URL, {
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
    logger.error('Discord token refresh failed:', { status: response.status, errorBody })
    // Discord APIのエラー詳細をメッセージに含め、呼び出し元で原因を特定可能にする
    // Include Discord API error details for caller to identify the cause
    throw new Error(`Failed to refresh Discord authentication token: ${response.status} ${errorBody}`)
  }

  return response.json()
}
