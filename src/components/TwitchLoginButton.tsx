'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { logger } from '@/lib/logger'

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
  const [isLoading, setIsLoading] = useState(false)

  const handleLogin = async () => {
    setIsLoading(true)
    try {
      const response = await fetch('/api/auth/twitch/login')
      const data = await response.json()
      if (data.authUrl) {
        window.location.href = data.authUrl
      }
    } catch (error) {
      logger.error('Login error:', { error })
      setIsLoading(false)
    }
  }

  return (
    <button
      onClick={handleLogin}
      disabled={isLoading}
      className={className}
    >
      {showIcon && (
        <svg className="h-6 w-6" fill="currentColor" viewBox="0 0 24 24">
          <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z" />
        </svg>
      )}
      {isLoading ? tCommon('loading') : t('twitchLogin')}
    </button>
  )
}

// 後方互換性のためのエイリアス
export function TwitchLoginButtonWithIcon({ className = '' }: { className?: string }) {
  return <TwitchLoginButton className={className} showIcon />
}
