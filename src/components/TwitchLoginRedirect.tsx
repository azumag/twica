'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { TwitchLoginResponse } from '@/types/auth'
import { logger } from '@/lib/logger'
import { fetchMaintenanceStatus } from '@/lib/maintenance/client'
import { parseTwitchAuthorizationResponse } from '@/lib/twitch/authorization-response'

/**
 * Component that redirects to Twitch login page
 * Twitchログインページにリダイレクトするコンポーネント
 *
 * 未認証ユーザーがdashboard/collectionの各layoutからサーバーコンポーネント
 * 経由でレンダーされる（session===null時のフォールバック）ため、常にセッションが
 * 無い状態＝常にMaintenanceStatusProviderの外で使われる（TwitchLoginButton.tsxの
 * コメント参照）。
 */
export function TwitchLoginRedirect() {
  const t = useTranslations('auth')
  const tMaintenance = useTranslations('maintenance')
  // #694 Stage 6c 既知の不具合対応（Stage 3のFableレビューで指摘）:
  // /api/auth/twitch/login はmaintenance中302リダイレクトを返す設計
  // (guardWriteRedirect)であり、fetch()はリダイレクトを追従するため
  // response.json()がリダイレクト先HTMLのパースに失敗して例外になっていた。
  // このコンポーネントは自動発火（マウント時にユーザー操作無しでfetchする）のため、
  // 従来は「リダイレクト中...」の表示のまま停止して見えるだけで実際には裏で
  // 例外が握りつぶされていた。マウント時にまずmaintenance状態を確認し、
  // ブロック中ならそもそもこのfetchを呼ばず、案内文言を表示する。
  const [isMaintenanceBlocked, setIsMaintenanceBlocked] = useState(false)
  // このコンポーネントはユーザー操作なしでマウント時に自動発火するため、
  // 検証失敗やネットワーク例外時も「リダイレクト中...」の表示のまま何も
  // 変わらないと、ユーザーはスピナーに取り残されてしまう。redirectFailed
  // で明示的に案内文言へ切り替える。
  const [redirectFailed, setRedirectFailed] = useState(false)

  useEffect(() => {
    let isMounted = true

    const handleLoginRedirect = async () => {
      const status = await fetchMaintenanceStatus()
      if (!isMounted) return
      if (status.mode !== 'off') {
        setIsMaintenanceBlocked(true)
        return
      }

      try {
        const response = await fetch('/api/auth/twitch/login')
        const data: TwitchLoginResponse = await response.json()

        if (data.authUrl && isMounted) {
          // 壊れたAPI応答や侵害時の外部URLをそのままwindow.locationへ渡さないため、
          // reauth/BOT接続と同じorigin/path/state検証を通す（Issue #865フォローアップ）。
          const authorization = parseTwitchAuthorizationResponse({
            loginUrl: data.authUrl,
            state: data.state,
          })
          if (authorization) {
            window.location.href = authorization.loginUrl
          } else {
            logger.error('[TwitchLoginRedirect] login response failed authorization URL validation')
            setRedirectFailed(true)
          }
        } else if (isMounted) {
          logger.error('[TwitchLoginRedirect] login response missing authUrl')
          setRedirectFailed(true)
        }
      } catch (error) {
        if (isMounted) {
          // Sentry removed for Cloudflare Workers bundle size reduction
          logger.error('[TwitchLoginRedirect]', error)
          setRedirectFailed(true)
        }
      }
    }

    handleLoginRedirect()

    return () => {
      isMounted = false
    }
  }, [])

  return (
    <div className="flex items-center justify-center">
      <div className="text-white">
        {isMaintenanceBlocked
          ? tMaintenance('writeDisabled')
          : redirectFailed
            ? t('loginFailed')
            : t('redirecting')}
      </div>
    </div>
  )
}
