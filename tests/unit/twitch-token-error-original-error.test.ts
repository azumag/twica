import { describe, expect, it } from 'vitest'
import { TwitchTokenError } from '@/lib/twitch/token-manager'

describe('TwitchTokenError originalError policy', () => {
  it('DATABASE_ERRORでは生のDBエラーを保持しない', () => {
    const originalError = Object.assign(new Error('database query failed'), {
      params: ['sensitive-token-value'],
    })

    const error = new TwitchTokenError(
      'Failed to fetch user tokens from database',
      'DATABASE_ERROR',
      originalError,
    )

    expect(error.originalError).toBeUndefined()
  })

  it('DATABASE_ERROR以外では既存のoriginalError契約を維持する', () => {
    const originalError = new Error('refresh failed')

    const error = new TwitchTokenError(
      'Failed to refresh Twitch access token',
      'REFRESH_FAILED',
      originalError,
    )

    expect(error.originalError).toBe(originalError)
  })
})
