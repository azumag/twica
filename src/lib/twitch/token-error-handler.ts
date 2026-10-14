import { NextResponse } from 'next/server'

import { ERROR_MESSAGES } from '@/lib/constants'
import { handleApiError, recordApiError } from '@/lib/error-handler'
import {
  TwitchTokenError,
  getTwitchAccessToken,
  isPermanentRefreshFailure,
  twitchTokenErrorReportContext,
} from '@/lib/twitch/token-manager'

/**
 * 有効なアクセストークンが無い状態(未連携、またはrefresh tokenが恒久的に失われた状態)
 * を表す経路内 sentinel。`requireTwitchAccessToken` が投げる。
 *
 * Twitch連携済みセッションでもトークン行が無い/refreshできない場合は
 * `getTwitchAccessToken` が `null` を返す。message文字列
 * (`ERROR_MESSAGES.TWITCH_TOKEN_REQUIRED`)の比較ではなく `instanceof` で分類できる
 * ようにするのが目的で、ユーザーへ返す文言は同じ。
 *
 * 注意: これはユーザー操作(再ログイン)で回復する通常状態であり、サーバー障害ではない。
 * そのため handleTwitchTokenError はこのエラーを errors テーブルへ記録しない
 * (恒久refresh失効のエラー記録は handleTwitchTokenError 側で維持する)。
 *
 * `requireTwitchAccessToken` の呼び出し側が型で捕捉できるようエクスポートする。
 */
export class MissingTwitchTokenError extends Error {
  constructor() {
    super(ERROR_MESSAGES.TWITCH_TOKEN_REQUIRED)
    this.name = 'MissingTwitchTokenError'
  }
}

/**
 * 有効なTwitchアクセストークンを取得する。取得できない場合は
 * `MissingTwitchTokenError` を投げ、route handler の catch が
 * `handleTwitchTokenError` で 401 + requiresReauth へ変換する。
 *
 * emotes / rewards で同一だった局所helperを1箇所へ寄せたもの(Issue #1088)。
 */
export async function requireTwitchAccessToken(twitchUserId: string): Promise<string> {
  const accessToken = await getTwitchAccessToken(twitchUserId)
  if (accessToken === null) {
    throw new MissingTwitchTokenError()
  }
  return accessToken
}

/**
 * step-up再認証でしか回復しないトークン状態かを判定する(Issue #1018 / #1088)。
 *
 * - `MissingTwitchTokenError`: 有効なアクセストークンが無い状態(未連携・恒久credential
 *   欠落)。再ログインで回復する。
 * - TwitchTokenError code='NO_TOKEN': DBにrefresh可能なトークンが無い防御的経路。
 * - TwitchTokenError code='REFRESH_FAILED' かつ恒久失効(400/401のhttp):
 *   判定の正本は token-manager.isPermanentRefreshFailure に委譲する。
 *
 * 一過性5xx(429/520等)・network・invalid_response・DB障害起因のrefresh失敗は
 * 再認証で回復しないためfalseを返し、呼び出し側は500(handleApiError)を維持する。
 * 判定の正本はこの1箇所に集約する(emotes / rewards / channel-point-bootstrap)。
 *
 * 記録方針は判定と分離する: MissingTwitchTokenError はユーザー操作で回復する通常状態
 * のため errors テーブルへ記録しない(handleTwitchTokenError を参照)。
 */
export function isReauthRequiredTokenError(error: unknown): boolean {
  if (error instanceof MissingTwitchTokenError) return true
  if (!(error instanceof TwitchTokenError)) return false
  if (error.code === 'NO_TOKEN') return true
  return isPermanentRefreshFailure(error)
}

/**
 * クライアントへ step-up 再認証CTAを表示させる 401 body契約。
 *
 * emotes / rewards GET・POST / channel-point-bootstrap が同一のbodyを返すことを
 * 1箇所で固定する。クライアント側の `requiresReauth === true` 判定
 * (例: ChannelPointSettings)と対になる契約なので、フィールド名を変えない。
 */
export function reauthRequiredResponse(): NextResponse {
  return NextResponse.json(
    { error: ERROR_MESSAGES.TWITCH_TOKEN_REQUIRED, requiresReauth: true },
    { status: 401 },
  )
}

/**
 * route handler の catch に重複していた token error 分岐を1箇所へ寄せる
 * (Issue #1088)。
 *
 * - `MissingTwitchTokenError`(未連携・恒久credential欠落): ユーザー操作(再ログイン)で
 *   回復する通常状態であり、サーバー障害として記録せず 401 + requiresReauth を返す。
 *   この判定は必ず他の分岐より先に行う(記録の有無だけが恒久失効との差分)。
 * - 恒久refresh失効(`isReauthRequiredTokenError`): 従来の診断永続化経路を維持したまま
 *   `recordApiError` で記録し、401 + requiresReauth を返す。汎用500へ倒すと
 *   auto-generated bug reportから恒久失効が見えなくなるため、記録は必ず行う。
 * - それ以外(一過性5xx/network/DB起因): `handleApiError` へ委譲して500を返す。
 *
 * capability確定状態の同期などroute固有の副作用は呼び出し側に残す。
 */
export async function handleTwitchTokenError(
  error: unknown,
  operation: string,
): Promise<NextResponse> {
  if (error instanceof MissingTwitchTokenError) {
    return reauthRequiredResponse()
  }
  if (isReauthRequiredTokenError(error)) {
    await recordApiError(error, operation, twitchTokenErrorReportContext(error))
    return reauthRequiredResponse()
  }
  // refresh診断の永続化・非二重報告契約は twitchTokenErrorReportContext のJSDocを参照。
  return handleApiError(error, operation, twitchTokenErrorReportContext(error))
}
