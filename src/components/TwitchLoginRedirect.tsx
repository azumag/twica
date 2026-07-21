'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { TwitchLoginResponse } from '@/types/auth'
import { fetchMaintenanceStatus } from '@/lib/maintenance/client'

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
          window.location.href = data.authUrl
        }
      } catch (error) {
        if (isMounted) {
          // Sentry removed for Cloudflare Workers bundle size reduction
          console.error('[TwitchLoginRedirect]', error)
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
        {isMaintenanceBlocked ? tMaintenance('writeDisabled') : t('redirecting')}
      </div>
    </div>
  )
}
