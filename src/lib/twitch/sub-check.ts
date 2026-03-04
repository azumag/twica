/**
 * Twitch サブスクライバー判定モジュール
 *
 * Twitch API の Check User Subscription エンドポイントで
 * 指定チャネルのサブスク状態を判定する。
 * getUserPlan() はキャッシュ済み DB 結果のみ参照し、API は直接呼ばない。
 *
 * キャッシュ戦略:
 * - 正常時: CACHE_DURATION_MS（1時間）で再検証
 * - APIエラー時: ERROR_CACHE_DURATION_MS（5分）で再検証（リトライストーム防止）
 * - 401/403: スコープ除去は行わず null を返す（一時障害での誤降格を防止）
 *   スコープ除去はユーザーの手動確認 API (check-subscription) でのみ行う
 */

import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getEnvVar } from '@/lib/env-validation'
import { getTwitchAccessToken } from '@/lib/twitch/token-manager'
import { ADDITIONAL_SCOPES } from '@/lib/twitch/auth'
import { logger } from '@/lib/logger'

// キャッシュ有効期間: 正常時1時間
const CACHE_DURATION_MS = 60 * 60 * 1000
// APIエラー時のキャッシュ有効期間: 5分（リトライストーム防止）
const ERROR_CACHE_DURATION_MS = 5 * 60 * 1000

/**
 * Twitch サブスク確認機能が有効か判定（環境変数チェック）
 */
export function isTwitchSubCheckEnabled(): boolean {
  return !!getEnvVar('TWITCH_BROADCASTER_ID')
}

/**
 * ユーザーが対象チャネルをサブスクライブしているか判定
 *
 * 1. twitch_sub_verified_at が1時間以内 → twitch_has_sub のキャッシュ結果を返す
 * 2. キャッシュ期限切れ → Twitch API で確認し、結果を DB に保存
 * 3. user:read:subscriptions スコープ未付与 → 即座に false
 */
export async function hasTwitchSub(twitchUserId: string): Promise<boolean> {
  if (!isTwitchSubCheckEnabled()) {
    return false
  }

  try {
    const supabaseAdmin = getSupabaseAdmin()

    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('twitch_sub_verified_at, twitch_has_sub, twitch_scopes')
      .eq('twitch_user_id', twitchUserId)
      .maybeSingle()

    if (error || !user) {
      return false
    }

    // user:read:subscriptions スコープがなければ判定不可
    if (!user.twitch_scopes?.includes(ADDITIONAL_SCOPES.USER_READ_SUBSCRIPTIONS)) {
      return false
    }

    // キャッシュ判定: 1時間以内なら前回の結果を返す
    if (user.twitch_sub_verified_at) {
      const verifiedAt = new Date(user.twitch_sub_verified_at).getTime()
      if (Date.now() - verifiedAt < CACHE_DURATION_MS) {
        return user.twitch_has_sub === true
      }
    }

    // キャッシュ期限切れ → Twitch API で確認
    const { hasSub } = await checkTwitchSubViaApi(twitchUserId)

    if (hasSub !== null) {
      // 正常結果: DB に保存（通常キャッシュ TTL で再検証）
      const { data: updatedUser, error: updateError } = await supabaseAdmin
        .from('users')
        .update({
          twitch_sub_verified_at: new Date().toISOString(),
          twitch_has_sub: hasSub,
        })
        .eq('twitch_user_id', twitchUserId)
        .select('twitch_user_id')
        .maybeSingle()

      // キャッシュ更新失敗はリクエスト継続に影響しない（次回アクセス時に再試行される）
      // ユーザー削除等で0行更新となっても、次回 hasTwitchSub() でユーザー未取得 → false で解消
      if (updateError || !updatedUser) {
        logger.error('[TwitchSub] Failed to update sub cache:', { twitchUserId, error: updateError, updatedUser })
      }

      return hasSub
    }

    // API エラー時: タイムスタンプのみ更新して短縮 TTL でリトライを抑制
    // twitch_has_sub は前回値を保持（ユーザーに不利にしない）
    // 計算: now - (1h - 5min) = 55分前 → キャッシュ判定で「55分 < 60分 = 有効」→ 5分後に期限切れ
    const errorCacheTimestamp = new Date(Date.now() - (CACHE_DURATION_MS - ERROR_CACHE_DURATION_MS))
    const { data: updatedTs, error: tsError } = await supabaseAdmin
      .from('users')
      .update({
        twitch_sub_verified_at: errorCacheTimestamp.toISOString(),
      })
      .eq('twitch_user_id', twitchUserId)
      .select('twitch_user_id')
      .maybeSingle()

    if (tsError || !updatedTs) {
      logger.error('[TwitchSub] Failed to update error cache timestamp:', { twitchUserId, error: tsError, updatedTs })
    }

    return user.twitch_has_sub === true
  } catch (error) {
    logger.error('[TwitchSub] Error checking subscription:', { twitchUserId, error })
    return false
  }
}

export type SubCheckResult = {
  hasSub: boolean | null
  /** 401/403 による認証エラーか（スコープ除去判断に使用） */
  authError: boolean
}

/**
 * Twitch API でサブスク状態を確認
 * @returns hasSub: true=サブスク中, false=非サブスク, null=APIエラー
 *          authError: 401/403 が原因のエラーか
 */
export async function checkTwitchSubViaApi(twitchUserId: string): Promise<SubCheckResult> {
  const broadcasterId = getEnvVar('TWITCH_BROADCASTER_ID')
  if (!broadcasterId) {
    return { hasSub: null, authError: false }
  }

  try {
    const accessToken = await getTwitchAccessToken(twitchUserId)
    if (!accessToken) {
      logger.warn('[TwitchSub] No access token available', { twitchUserId })
      return { hasSub: null, authError: false }
    }

    const clientId = getEnvVar('NEXT_PUBLIC_TWITCH_CLIENT_ID', true)!
    const url = `https://api.twitch.tv/helix/subscriptions/user?broadcaster_id=${broadcasterId}&user_id=${twitchUserId}`

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Client-Id': clientId,
      },
    })

    if (response.ok) {
      return { hasSub: true, authError: false }
    }

    if (response.status === 404) {
      // 404: 非サブスク（正常系 — 明示的に false を返してプラン降格を実行）
      return { hasSub: false, authError: false }
    }

    if (response.status === 401 || response.status === 403) {
      // 401/403: トークンまたはスコープの問題
      // ※ バックグラウンド処理（hasTwitchSub）からはスコープ除去しない。
      //   一時的な Twitch 障害で誤ってスコープを剥奪するとプラン降格が発生するため。
      //   スコープ除去はユーザーの手動確認 API (check-subscription) でのみ行う。
      logger.warn('[TwitchSub] Auth error (scope removal deferred to manual check)', {
        twitchUserId,
        status: response.status,
      })
      return { hasSub: null, authError: true }
    }

    // その他のエラー（5xx, ネットワーク障害等）: 前回結果を保持
    logger.warn('[TwitchSub] Unexpected API response', {
      twitchUserId,
      status: response.status,
    })
    return { hasSub: null, authError: false }
  } catch (error) {
    logger.error('[TwitchSub] API call failed', { twitchUserId, error })
    return { hasSub: null, authError: false }
  }
}
