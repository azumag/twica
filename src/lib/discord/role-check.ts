/**
 * Discord サブスクライバーロール判定モジュール
 *
 * Discord OAuth2 の guilds.members.read スコープで取得したロール情報から
 * Twitch サブスクライバーロールの有無を判定する。
 * 1時間キャッシュにより Discord API への過剰なリクエストを防止。
 * ロールの有無に関わらずキャッシュが効くため、ロールなしユーザーでもAPI負荷は最小限。
 */

import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getEnvVar } from '@/lib/env-validation'
import { getGuildMember } from '@/lib/discord/auth'
import { logger } from '@/lib/logger'

// キャッシュ有効期間: 1時間
const CACHE_DURATION_MS = 60 * 60 * 1000

/**
 * Discord連携が有効か判定（環境変数設定チェック）
 */
export function isDiscordEnabled(): boolean {
  return !!(
    getEnvVar('DISCORD_CLIENT_ID') &&
    getEnvVar('DISCORD_CLIENT_SECRET') &&
    getEnvVar('DISCORD_GUILD_ID') &&
    getEnvVar('DISCORD_SUB_ROLE_ID')
  )
}

/**
 * ユーザーが Discord サブスクライバーロールを持っているか判定
 *
 * 1. discord_sub_verified_at が1時間以内 → discord_has_sub_role のキャッシュ結果を返す
 * 2. キャッシュ期限切れ → Discord API でロール確認し、両カラムを更新
 * 3. Discord未連携 → 即座に false
 */
export async function hasDiscordSubRole(twitchUserId: string): Promise<boolean> {
  if (!isDiscordEnabled()) {
    return false
  }

  try {
    const supabaseAdmin = getSupabaseAdmin()

    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('discord_user_id, discord_access_token, discord_refresh_token, discord_token_expires_at, discord_sub_verified_at, discord_has_sub_role')
      .eq('twitch_user_id', twitchUserId)
      .maybeSingle()

    if (error) {
      if (error.code === 'PGRST204') {
        return false
      }
      logger.error('[Discord] Failed to fetch user Discord info:', { twitchUserId, error })
      return false
    }

    if (!user?.discord_user_id || !user?.discord_access_token) {
      return false
    }

    // キャッシュ判定: discord_sub_verified_at が1時間以内なら前回の結果を返す
    // ロールの有無に関わらずキャッシュが効く（ロールなしユーザーでもAPI呼び出しを抑制）
    if (user.discord_sub_verified_at) {
      const verifiedAt = new Date(user.discord_sub_verified_at).getTime()
      if (Date.now() - verifiedAt < CACHE_DURATION_MS) {
        return user.discord_has_sub_role === true
      }
    }

    // キャッシュ期限切れまたは未確認 → Discord API でロール確認
    const hasRole = await checkRoleViaApi(twitchUserId, user)

    // ロールの有無に関わらずチェック日時とロール状態を更新
    const { error: updateError } = await supabaseAdmin
      .from('users')
      .update({
        discord_sub_verified_at: new Date().toISOString(),
        discord_has_sub_role: hasRole,
      })
      .eq('twitch_user_id', twitchUserId)

    if (updateError) {
      logger.warn('[Discord] Failed to update role cache:', { twitchUserId, error: updateError })
    }

    return hasRole
  } catch (error) {
    logger.error('[Discord] Error checking sub role:', { twitchUserId, error })
    return false
  }
}

/**
 * Discord API を使ってロールを確認（内部関数）
 * auth.ts の getGuildMember を使用してコード重複を排除
 */
async function checkRoleViaApi(
  twitchUserId: string,
  user: {
    discord_access_token: string
    discord_refresh_token: string | null
    discord_token_expires_at: string | null
  }
): Promise<boolean> {
  const guildId = getEnvVar('DISCORD_GUILD_ID')!
  const subRoleId = getEnvVar('DISCORD_SUB_ROLE_ID')!

  // トークン有効期限チェック → 期限切れなら自動リフレッシュ
  let accessToken = user.discord_access_token
  if (user.discord_token_expires_at) {
    const expiresAt = new Date(user.discord_token_expires_at).getTime()
    if (Date.now() >= expiresAt && user.discord_refresh_token) {
      try {
        // 循環import回避: role-check → token-manager → auth の依存チェーン
        const { getDiscordAccessToken } = await import('@/lib/discord/token-manager')
        const refreshedToken = await getDiscordAccessToken(twitchUserId)
        if (!refreshedToken) {
          logger.warn('[Discord] Token refresh returned null', { twitchUserId })
          return false
        }
        accessToken = refreshedToken
      } catch (error) {
        logger.error('[Discord] Token refresh failed during role check', { twitchUserId, error })
        return false
      }
    }
  }

  try {
    const member = await getGuildMember(accessToken, guildId)
    return member.roles.includes(subRoleId)
  } catch (error) {
    // getGuildMember は 403/404 でもthrowするため、ここでキャッチ
    // ギルド未参加やAPI一時障害はロールなしとして扱う
    logger.info('[Discord] Guild member check failed', {
      twitchUserId,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}
