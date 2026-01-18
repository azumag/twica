'use client'

import { useEffect } from 'react'
import { TwitchLoginResponse } from '@/types/auth'
import { UI_STRINGS } from '@/lib/constants'

export function TwitchLoginRedirect() {
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
          console.error('Failed to initiate login:', error)
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
