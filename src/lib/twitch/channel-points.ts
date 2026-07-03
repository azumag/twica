import { getEnvVar } from '@/lib/env-validation'
import { getTwitchAccessToken } from './token-manager'
import { logger } from '@/lib/logger'

const TWITCH_API_URL = 'https://api.twitch.tv/helix'

export interface CancelRedemptionParams {
  /** 配信者のTwitchユーザーID（数値ID文字列。EventSub payload の broadcaster_user_id） */
  broadcasterTwitchUserId: string
  /** チャンネルポイント報酬ID（EventSub payload の reward.id） */
  rewardId: string
  /** 返還対象のredemption ID（EventSub payload の event.id） */
  redemptionId: string
}

export interface CancelRedemptionResult {
  success: boolean
  /** 失敗理由（ログ/reportError用の分類文字列。成功時はundefined） */
  reason?: string
}

/**
 * Twitch の Update Redemption Status API で redemption を CANCELED に更新し、
 * 視聴者のチャンネルポイントを自動返還する (Issue #546)。
 *
 * 背景: カード発行枚数の上限到達等でガチャが失敗しても、EventSub は
 * チャンネルポイント消費後に発火するため、視聴者のポイントは既に消費されている。
 * このアプリが作成するカスタム報酬は `should_redemptions_skip_request_queue` を
 * 設定していない(= デフォルトfalse)ため、redemption は明示的に FULFILLED/CANCELED
 * へ更新するまで「未処理」のまま残り続ける。CANCELED に更新すると Twitch 側が
 * ポイントを自動返還する(Twitch公式仕様)。
 *
 * 認証には配信者本人のアクセストークンを使う。チャンネルポイント連携を有効化した
 * 配信者は `channel:manage:redemptions` スコープを既に付与済みの想定
 * (src/lib/twitch/scopes.ts の CHANNEL_POINT_SCOPES)。
 *
 * 呼び出し元 (eventsub route の売り切れハンドリング) は「ガチャ自体は既に失敗
 * している」状態からさらに呼ばれる副次的な救済処理であり、この関数の失敗を
 * 致命的エラーとして扱わない。そのため例外を投げず、必ず CancelRedemptionResult
 * を返す設計にしている。
 *
 * Calls Twitch's "Update Redemption Status" API to set a redemption to CANCELED,
 * which makes Twitch automatically refund the viewer's channel points (Issue #546).
 * Uses the broadcaster's own access token (requires `channel:manage:redemptions`).
 * Never throws — callers treat a refund failure as non-fatal (the gacha draw has
 * already failed by the time this runs), so this always resolves to a result object.
 *
 * @see https://dev.twitch.tv/docs/api/reference/#update-redemption-status
 */
export async function cancelRedemption(params: CancelRedemptionParams): Promise<CancelRedemptionResult> {
  const { broadcasterTwitchUserId, rewardId, redemptionId } = params

  try {
    const accessToken = await getTwitchAccessToken(broadcasterTwitchUserId)
    if (!accessToken) {
      logger.warn('[cancelRedemption] No access token available for broadcaster', {
        broadcasterTwitchUserId,
        rewardId,
        redemptionId,
      })
      return { success: false, reason: 'no_access_token' }
    }

    const clientId = getEnvVar('NEXT_PUBLIC_TWITCH_CLIENT_ID', true)!
    const query = new URLSearchParams({
      broadcaster_id: broadcasterTwitchUserId,
      reward_id: rewardId,
      id: redemptionId,
    })

    const response = await fetch(`${TWITCH_API_URL}/channel_points/custom_rewards/redemptions?${query.toString()}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Client-Id': clientId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status: 'CANCELED' }),
    })

    if (response.ok) {
      return { success: true }
    }

    const errorBody = await response.text().catch(() => '')
    logger.warn('[cancelRedemption] Twitch API returned an error response', {
      broadcasterTwitchUserId,
      rewardId,
      redemptionId,
      status: response.status,
      errorBody,
    })
    return { success: false, reason: `http_${response.status}` }
  } catch (error) {
    // ネットワーク例外等。呼び出し元でreportErrorするため、ここではwarnログのみ。
    logger.error('[cancelRedemption] Request failed', {
      broadcasterTwitchUserId,
      rewardId,
      redemptionId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { success: false, reason: 'exception' }
  }
}
