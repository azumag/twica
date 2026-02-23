import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { refreshDiscordToken, type DiscordTokens } from './auth'
import { logger } from '@/lib/logger'

/**
 * Discord トークン操作で発生するエラークラス
 * Twitchパターンと統一したエラーコードを使用する
 *
 * Error class for Discord token operations.
 * Uses the same error codes as the Twitch pattern for consistency.
 */
export class DiscordTokenError extends Error {
  constructor(
    message: string,
    public readonly code: 'NO_TOKEN' | 'REFRESH_FAILED' | 'DATABASE_ERROR' | 'USER_NOT_FOUND',
    public readonly originalError?: Error
  ) {
    super(message)
    this.name = 'DiscordTokenError'
  }
}

/**
 * Discordアクセストークンを取得する（期限切れ時は自動リフレッシュ）
 * トークンが存在しないか取得できない場合はnullを返す
 *
 * Get Discord access token (auto-refresh if expired).
 * Returns null if the token doesn't exist or cannot be retrieved.
 *
 * @param twitchUserId - ユーザーのTwitch ID（DBの主キー代替） / User's Twitch ID (used as DB lookup key)
 * @returns 有効なアクセストークン、または null / Valid access token or null
 */
export async function getDiscordAccessToken(twitchUserId: string): Promise<string | null> {
  const supabaseAdmin = getSupabaseAdmin()

  const { data: user, error: dbError } = await supabaseAdmin
    .from('users')
    .select('discord_access_token, discord_refresh_token, discord_token_expires_at')
    .eq('twitch_user_id', twitchUserId)
    .maybeSingle()

  if (dbError) {
    // PGRST204 はカラム未存在を意味する。Discordカラムのマイグレーション前は正常ケース
    // PGRST204 means column not found - expected before Discord column migration runs
    if (dbError.code === 'PGRST204') {
      logger.warn('Discord token columns not found in schema', { twitchUserId, error: dbError })
      return null
    }

    // その他のDBエラーは予期せぬ障害としてスロー
    // maybeSingle() により行未存在はerrorではなくdata=nullが返るため、ここはDBエラー確定
    // Other database errors are unexpected failures and should be thrown.
    // maybeSingle() returns data=null (not error) when no row is found, so this is a genuine DB error.
    logger.error('Database error fetching Discord user tokens', { twitchUserId, error: dbError })
    throw new DiscordTokenError(
      'Failed to fetch Discord tokens from database',
      'DATABASE_ERROR',
      dbError
    )
  }

  if (!user || !user.discord_access_token || !user.discord_refresh_token) {
    // Discord未連携、またはトークンが保存されていない
    // Discord not linked, or token not yet saved
    return null
  }

  if (!user.discord_token_expires_at) {
    return null
  }

  const expiresAt = new Date(user.discord_token_expires_at)
  if (isNaN(expiresAt.getTime())) {
    // 不正な日付文字列はDBの不整合を意味するためnullを返す
    // Invalid date string indicates DB inconsistency; return null
    return null
  }

  const now = new Date()
  if (expiresAt > now) {
    // トークンはまだ有効
    // Token is still valid
    return user.discord_access_token
  }

  // トークン期限切れ → 自動リフレッシュ
  // Token expired → auto-refresh
  return await refreshDiscordAccessToken(twitchUserId, user.discord_refresh_token)
}

/**
 * Discordアクセストークンをリフレッシュし、DBに保存する（内部関数）
 * Refresh Discord access token and persist to DB (internal function)
 */
async function refreshDiscordAccessToken(
  twitchUserId: string,
  refreshToken: string
): Promise<string> {
  try {
    const tokens = await refreshDiscordToken(refreshToken)
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000)

    const supabaseAdmin = getSupabaseAdmin()
    const { error } = await supabaseAdmin
      .from('users')
      .update({
        discord_access_token: tokens.access_token,
        discord_refresh_token: tokens.refresh_token,
        discord_token_expires_at: expiresAt.toISOString(),
      })
      .eq('twitch_user_id', twitchUserId)

    if (error) {
      // PGRST204: カラム未存在 → 保存をスキップしてトークンのみ返す
      // PGRST204: column not found → skip save, return token only
      if (error.code === 'PGRST204') {
        logger.warn('Discord token columns not found in schema, returning token without saving', {
          twitchUserId,
          error,
        })
        return tokens.access_token
      }
      throw error
    }

    return tokens.access_token
  } catch (error) {
    logger.error('Failed to refresh Discord access token', { twitchUserId, error })
    throw new DiscordTokenError(
      'Failed to refresh Discord access token',
      'REFRESH_FAILED',
      error instanceof Error ? error : undefined
    )
  }
}

/**
 * DiscordトークンとユーザーIDをDBに保存する
 * Discord OAuth連携完了時に呼び出す
 *
 * Save Discord tokens and user ID to database.
 * Called when Discord OAuth linking is completed.
 *
 * @param twitchUserId - ユーザーのTwitch ID / User's Twitch ID
 * @param tokens - Discord APIから受け取ったトークン / Tokens received from Discord API
 * @param discordUserId - DiscordユーザーID / Discord user ID
 */
export async function saveDiscordTokens(
  twitchUserId: string,
  tokens: DiscordTokens,
  discordUserId: string
): Promise<void> {
  const supabaseAdmin = getSupabaseAdmin()
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000)

  const { error } = await supabaseAdmin
    .from('users')
    .update({
      discord_user_id: discordUserId,
      discord_access_token: tokens.access_token,
      discord_refresh_token: tokens.refresh_token,
      discord_token_expires_at: expiresAt.toISOString(),
    })
    .eq('twitch_user_id', twitchUserId)

  if (error) {
    // PGRST204: カラム未存在 → ログだけ記録してリターン（マイグレーション前は正常）
    // PGRST204: column not found → log and return (expected before migration)
    if (error.code === 'PGRST204') {
      logger.warn('Discord token columns not found in schema, skipping save', {
        twitchUserId,
        error,
      })
      return
    }
    logger.error('Failed to save Discord tokens', { twitchUserId, discordUserId, error })
    throw error
  }

  logger.info('Saved Discord tokens for user', { twitchUserId, discordUserId })
}

/**
 * Discord連携解除時にトークンとユーザー情報を全てnullにリセットする
 * discord_sub_verified_at も合わせてリセットし、サブスク検証状態をクリアする
 *
 * Reset all Discord tokens and user info to null when unlinking.
 * Also resets discord_sub_verified_at to clear subscription verification state.
 *
 * @param twitchUserId - ユーザーのTwitch ID / User's Twitch ID
 */
export async function deleteDiscordTokens(twitchUserId: string): Promise<void> {
  const supabaseAdmin = getSupabaseAdmin()

  const { error } = await supabaseAdmin
    .from('users')
    .update({
      discord_user_id: null,
      discord_access_token: null,
      discord_refresh_token: null,
      discord_token_expires_at: null,
      // サブスク検証日時とロールフラグもリセット（連携解除でサブスク資格を失うため）
      // Reset subscription verification and role flag (user loses subscription entitlements on unlink)
      discord_sub_verified_at: null,
      discord_has_sub_role: false,
    })
    .eq('twitch_user_id', twitchUserId)

  if (error) {
    // PGRST204: カラム未存在 → ログだけ記録してリターン（マイグレーション前は正常）
    // PGRST204: column not found → log and return (expected before migration)
    if (error.code === 'PGRST204') {
      logger.warn('Discord token columns not found in schema, skipping deletion', {
        twitchUserId,
        error,
      })
      return
    }
    logger.error('Failed to delete Discord tokens', { twitchUserId, error })
    throw error
  }

  logger.info('Deleted Discord tokens for user', { twitchUserId })
}
