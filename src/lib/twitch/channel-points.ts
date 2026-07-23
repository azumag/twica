import { getEnvVar } from '@/lib/env-validation'
import { getTwitchAccessToken } from './token-manager'
import { logger } from '@/lib/logger'

const TWITCH_API_URL = 'https://api.twitch.tv/helix'

// Twitch APIへの疎通確認が異常に長引いてcallback/API route全体を巻き込んで
// 遅延させないためのタイムアウト（#788子A #789）。
const CAPABILITY_PROBE_TIMEOUT_MS = 5000

export type ChannelPointsCapability = 'available' | 'unavailable' | 'reauth_required' | 'unknown'

export type ChannelPointsCapabilityReason =
  | 'ok'
  | 'no_access_token'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'twitch_server_error'
  | 'unexpected_status'
  | 'network_error'

export interface ChannelPointsCapabilityResult {
  capability: ChannelPointsCapability
  reason: ChannelPointsCapabilityReason
  httpStatus?: number
  /**
   * true: 200/401/403相当の確定結果。呼び出し元はDBの確定状態を上書きしてよい。
   * false: 429/5xx/network error等の一時失敗。呼び出し元は既存の確定状態を
   *        破壊してはならない（#788親issueの中核要件）。
   */
  definitive: boolean
}

/** definitive=true をリテラル型で強制する。一時失敗の結果を誤って永続化APIへ渡せなくする。 */
export type DefinitiveCapabilityResult = ChannelPointsCapabilityResult & { definitive: true }

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

/**
 * 非Affiliateユーザーを含む配信者本人のChannel Points利用可否を判定する
 * Capability Probe (#788 子A #789)。
 *
 * `GET /helix/channel_points/custom_rewards?broadcaster_id=...&only_manageable_rewards=true`
 * を呼ぶだけの非破壊・読み取り専用リクエストで、報酬の作成・更新・削除は行わない。
 * `only_manageable_rewards=true` により、報酬が0件でも利用可能なら200・空配列が
 * 返るため、報酬件数ではなくHTTPステータスのみで判定する（報酬タイトルや
 * broadcaster_typeは判定材料にしない）。
 *
 * `cancelRedemption`と同じ非throwスタイル: 通常のTwitch拒否（401/403等）では
 * 例外を投げず、呼び出し元がUI/DB契約へ変換しやすい結果オブジェクトを返す。
 *
 * @see https://dev.twitch.tv/docs/api/reference/#get-custom-reward
 */
export async function probeChannelPointsCapability(
  broadcasterTwitchUserId: string
): Promise<ChannelPointsCapabilityResult> {
  const accessToken = await getTwitchAccessToken(broadcasterTwitchUserId)
  if (!accessToken) {
    return { capability: 'reauth_required', reason: 'no_access_token', definitive: true }
  }

  const clientId = getEnvVar('NEXT_PUBLIC_TWITCH_CLIENT_ID', true)!
  const query = new URLSearchParams({
    broadcaster_id: broadcasterTwitchUserId,
    only_manageable_rewards: 'true',
  })

  let response: Response
  try {
    response = await fetch(`${TWITCH_API_URL}/channel_points/custom_rewards?${query.toString()}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Client-Id': clientId,
      },
      signal: AbortSignal.timeout(CAPABILITY_PROBE_TIMEOUT_MS),
    })
  } catch (error) {
    // access token / Authorization headerはログへ出さない。分類済みreasonのみ残す。
    logger.warn('[probeChannelPointsCapability] Request failed', {
      broadcasterTwitchUserId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { capability: 'unknown', reason: 'network_error', definitive: false }
  }

  if (response.status === 200) {
    return { capability: 'available', reason: 'ok', httpStatus: 200, definitive: true }
  }
  if (response.status === 401) {
    return { capability: 'reauth_required', reason: 'unauthorized', httpStatus: 401, definitive: true }
  }
  if (response.status === 403) {
    return { capability: 'unavailable', reason: 'forbidden', httpStatus: 403, definitive: true }
  }
  if (response.status === 429) {
    return { capability: 'unknown', reason: 'rate_limited', httpStatus: 429, definitive: false }
  }
  if (response.status >= 500) {
    return { capability: 'unknown', reason: 'twitch_server_error', httpStatus: response.status, definitive: false }
  }

  // その他の非2xx。レスポンス本文は機密情報を含み得るためログへ出さない。
  logger.warn('[probeChannelPointsCapability] Unexpected Twitch API status', {
    broadcasterTwitchUserId,
    status: response.status,
  })
  return { capability: 'unknown', reason: 'unexpected_status', httpStatus: response.status, definitive: false }
}
