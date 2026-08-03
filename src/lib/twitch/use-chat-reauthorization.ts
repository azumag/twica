'use client'

import { useCallback, useRef, useState } from 'react'
import { COOKIE_NAMES } from '@/lib/constants'
import { parseMaintenanceError } from '@/lib/maintenance/client'
import { ADDITIONAL_SCOPES } from '@/lib/twitch/scopes'

export type ChatReauthorizationFailure = 'maintenance' | 'request'

const TWITCH_AUTHORIZATION_ORIGIN = 'https://id.twitch.tv'
const TWITCH_AUTHORIZATION_PATH = '/oauth2/authorize'

/**
 * reauth APIの成功bodyを、ブラウザ遷移へ使ってよいTwitch OAuth URLへ正規化する。
 *
 * 型確認だけでは、壊れたAPI応答や侵害時の外部URLを `window.location` へ渡してしまう。
 * Twitch公式の認可endpoint（https://id.twitch.tv/oauth2/authorize）に限定し、URL内の
 * stateとCookieへ保存するstateが一致することまで確認してから遷移する。これにより
 * 2つのCTAが同じOAuth/CSRF境界を共有し、片方だけ検証が弱くなる回帰を防ぐ。
 */
function parseTwitchAuthorizationResponse(body: unknown): {
  loginUrl: string
  state: string
} | null {
  if (typeof body !== 'object' || body === null) return null

  const { loginUrl, state } = body as Record<string, unknown>
  if (typeof loginUrl !== 'string' || typeof state !== 'string' || state.length === 0) {
    return null
  }

  try {
    const url = new URL(loginUrl)
    if (
      url.origin !== TWITCH_AUTHORIZATION_ORIGIN ||
      url.pathname !== TWITCH_AUTHORIZATION_PATH ||
      url.username !== '' ||
      url.password !== '' ||
      url.searchParams.get('state') !== state
    ) {
      return null
    }
    return { loginUrl: url.href, state }
  } catch {
    return null
  }
}

/**
 * user:write:chat のstep-up再認証を開始する、チャット通知専用hook。
 *
 * ChatDeliveryWarningとChatAnnouncementSettingsは表示文言や周辺stateが異なるため、
 * UIエラー文字列は呼び出し元で選ぶ。一方、二重送信防止、maintenance分類、JSONと
 * OAuth URLの検証、state Cookie、redirectというセキュリティ上の中核処理はここへ
 * 集約する。各hook呼び出しのstateは独立しており、コンポーネント間で共有しない。
 */
export function useChatReauthorization(isMaintenanceBlocked: boolean): {
  reauthorizing: boolean
  reauthorize: () => Promise<ChatReauthorizationFailure | null>
} {
  const [reauthorizing, setReauthorizing] = useState(false)
  // Reactのstate反映前に連続clickされた場合も、OAuth stateを複数発行して後着Cookieで
  // 上書きしないよう同期的なrefを併用する。失敗時だけ解除し、成功時はnavigation完了
  // まで再実行を禁止する。
  const inFlightRef = useRef(false)

  const reauthorize = useCallback(async (): Promise<ChatReauthorizationFailure | null> => {
    if (isMaintenanceBlocked) return 'maintenance'
    if (inFlightRef.current) return null

    inFlightRef.current = true
    setReauthorizing(true)
    let redirectStarted = false

    try {
      const response = await fetch('/api/auth/reauth', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ additionalScopes: [ADDITIONAL_SCOPES.CHAT_WRITE] }),
      })
      // Response bodyは一度だけ読む。非JSON成功も失敗応答も例外へせず、下のtypedな
      // failureへ正規化することで、両CTAのloading解除と表示を必ず一致させる。
      const responseBody: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        return parseMaintenanceError(response, responseBody) ? 'maintenance' : 'request'
      }

      const authorization = parseTwitchAuthorizationResponse(responseBody)
      if (!authorization) return 'request'

      // callbackでOAuth stateを検証するための短命Cookie。stateはserver生成の一時値で、
      // access tokenではない。既存フローと同じ10分・Secure・SameSite=Laxを維持する。
      document.cookie = `${COOKIE_NAMES.AUTH_STATE}=${authorization.state}; path=/; max-age=600; secure; samesite=lax`
      window.location.href = authorization.loginUrl
      redirectStarted = true
      return null
    } catch {
      return 'request'
    } finally {
      if (!redirectStarted) {
        inFlightRef.current = false
        setReauthorizing(false)
      }
    }
  }, [isMaintenanceBlocked])

  return { reauthorizing, reauthorize }
}
