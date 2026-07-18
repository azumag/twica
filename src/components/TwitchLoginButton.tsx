'use client'

import { useState, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { logger } from '@/lib/logger'
import { fetchMaintenanceStatus } from '@/lib/maintenance/client'

interface TwitchLoginButtonProps {
  className?: string
  showIcon?: boolean
}

/**
 * Twitch Login Button Component
 * Handles OAuth login flow with Twitch
 * Twitchログインボタンコンポーネント - TwitchとのOAuthログインフローを処理
 */
export function TwitchLoginButton({ className = '', showIcon = false }: TwitchLoginButtonProps) {
  const t = useTranslations('auth')
  const tCommon = useTranslations('common')
  const tMaintenance = useTranslations('maintenance')
  const [isLoading, setIsLoading] = useState(false)
  // #694 Stage 6c: このボタンはダッシュボード外（未ログイン状態のトップページ等）
  // でも使われるため、dashboard/layout.tsxのMaintenanceStatusProviderは前提に
  // できない（useMaintenanceStatus()はProvider外では常にmode:'offを返す設計
  // ——MaintenanceStatusProvider.tsx参照——なので、Context経由では検知できない）。
  // そのためこのコンポーネント自身がマウント時に一度だけ状態を取得する。
  //
  // 既知の不具合（Stage 3のFableレビューで指摘）: /api/auth/twitch/login は
  // maintenance中302リダイレクトを返す設計(guardWriteRedirect)であり、
  // fetch()はデフォルトでリダイレクトを追従するため、response.json()が
  // リダイレクト先HTMLのパースに失敗して静かに失敗していた（ユーザーには
  // 何も表示されずボタンが無反応に見える）。mode!=offを検出した時点で
  // そもそもこのfetchを呼ばないようにする。
  const [maintenanceMode, setMaintenanceMode] = useState<string>('off')
  const isMaintenanceBlocked = maintenanceMode !== 'off'

  useEffect(() => {
    let cancelled = false
    fetchMaintenanceStatus().then((status) => {
      if (!cancelled) {
        setMaintenanceMode(status.mode)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const handleLogin = async () => {
    // 事前disable(ボタン)をすり抜けた場合（マウント直後のクリック等）でも、
    // 既知の不具合のあるfetchを発火させないための二重ガード。
    if (isMaintenanceBlocked) {
      return
    }

    setIsLoading(true)
    try {
      const response = await fetch('/api/auth/twitch/login')

      // Check if response is OK and content-type is JSON
      // APIからのレスポンスが正常でJSONであることを確認
      const contentType = response.headers.get('content-type')
      if (!response.ok || !contentType?.includes('application/json')) {
        // If the response is a redirect or HTML error page, log details and show error
        // リダイレクトやHTMLエラーページの場合、詳細をログに記録してエラーを表示
        logger.error('Login API returned non-JSON response:', {
          status: response.status,
          contentType,
          url: response.url,
        })
        setIsLoading(false)
        return
      }

      const data = await response.json()
      if (data.authUrl) {
        window.location.href = data.authUrl
      } else if (data.error) {
        // Handle JSON error response from API
        // APIからのJSONエラーレスポンスを処理
        logger.error('Login API error:', { error: data.error })
        setIsLoading(false)
      }
    } catch (error) {
      logger.error('Login error:', { error })
      setIsLoading(false)
    }
  }

  return (
    <button
      onClick={handleLogin}
      disabled={isLoading || isMaintenanceBlocked}
      title={isMaintenanceBlocked ? tMaintenance('writeDisabled') : undefined}
      className={className}
    >
      {showIcon && (
        <svg className="h-6 w-6" fill="currentColor" viewBox="0 0 24 24">
          <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z" />
        </svg>
      )}
      {isLoading ? tCommon('loading') : isMaintenanceBlocked ? tMaintenance('writeDisabled') : t('twitchLogin')}
    </button>
  )
}

// 後方互換性のためのエイリアス
export function TwitchLoginButtonWithIcon({ className = '' }: { className?: string }) {
  return <TwitchLoginButton className={className} showIcon />
}
