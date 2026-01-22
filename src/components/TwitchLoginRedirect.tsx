'use client'

import { useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { TwitchLoginResponse } from '@/types/auth'
import * as Sentry from '@sentry/nextjs'

/**
 * Component that redirects to Twitch login page
 * Twitchログインページにリダイレクトするコンポーネント
 */
export function TwitchLoginRedirect() {
  const t = useTranslations('auth')

  useEffect(() => {
    let isMounted = true

    const handleLoginRedirect = async () => {
      try {
        const response = await fetch('/api/auth/twitch/login')
        const data: TwitchLoginResponse = await response.json()

        if (data.authUrl && isMounted) {
          window.location.href = data.authUrl
        }
      } catch (error) {
        if (isMounted) {
          Sentry.captureException(error)
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
      <div className="text-white">{t('redirecting')}</div>
    </div>
  )
}
