'use client'

import { useEffect } from 'react'
import { TwitchLoginResponse } from '@/types/auth'
import { UI_STRINGS } from '@/lib/constants'
import * as Sentry from '@sentry/nextjs'

export function TwitchLoginRedirect() {
  useEffect(() => {
    let isMounted = true

    const handleLoginRedirect = async () => {
      try {
        // First, check if we have a valid session
        const sessionResponse = await fetch('/api/session', {
          credentials: 'include',
        })

        if (sessionResponse.ok) {
          // Session is valid, reload the page
          if (isMounted) {
            window.location.reload()
          }
          return
        }

        // No valid session, proceed with login redirect
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
      <div className="text-white">{UI_STRINGS.AUTH.REDIRECTING}</div>
    </div>
  )
}
