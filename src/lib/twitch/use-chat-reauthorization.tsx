'use client'

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useMaintenanceStatus } from '@/components/MaintenanceStatusProvider'
import { COOKIE_NAMES } from '@/lib/constants'
import { parseMaintenanceError } from '@/lib/maintenance/client'
import { ADDITIONAL_SCOPES } from '@/lib/twitch/scopes'

export type ChatReauthorizationFailure = 'maintenance' | 'request'

interface ChatReauthorizationContextValue {
  reauthorizing: boolean
  reauthorize: () => Promise<ChatReauthorizationFailure | null>
}

const TWITCH_AUTHORIZATION_ORIGIN = 'https://id.twitch.tv'
const TWITCH_AUTHORIZATION_PATH = '/oauth2/authorize'
const ChatReauthorizationContext = createContext<ChatReauthorizationContextValue | null>(null)

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
 * user:write:chat のstep-up再認証をダッシュボード内で1系統だけ管理するProvider。
 *
 * Settingsページでは共通警告と設定sectionのCTAが同時に存在する。各componentが
 * 独立したrefを持つと、別CTAの連続操作でreauth APIが2回走り、後着のOAuth stateが
 * Cookieを上書きする。dashboard layoutにProviderを1つ置き、loading・同期ref・requestを
 * Context共有することで、どのCTAから開始してもページ全体でsingle-flightにする。
 */
export function ChatReauthorizationProvider({ children }: { children: ReactNode }) {
  const { mode: maintenanceMode } = useMaintenanceStatus()
  const isMaintenanceBlocked = maintenanceMode !== 'off'
  const [reauthorizing, setReauthorizing] = useState(false)
  // state反映前に別consumerが続けて呼んでも、OAuth stateを複数発行しない同期guard。
  // 失敗時だけ解除し、成功時はnavigation完了まで再実行を禁止する。
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

  const value = useMemo(
    () => ({ reauthorizing, reauthorize }),
    [reauthorizing, reauthorize],
  )

  return (
    <ChatReauthorizationContext.Provider value={value}>
      {children}
    </ChatReauthorizationContext.Provider>
  )
}

/**
 * dashboard共有の再認証controllerを読む。Providerなしで独立controllerへ縮退すると、
 * 将来の配置変更で二重送信が静かに再発するため、配線漏れは即座に例外で検出する。
 */
export function useChatReauthorization(): ChatReauthorizationContextValue {
  const context = useContext(ChatReauthorizationContext)
  if (!context) {
    throw new Error('useChatReauthorization must be used within ChatReauthorizationProvider')
  }
  return context
}
