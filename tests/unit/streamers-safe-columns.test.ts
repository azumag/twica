import { describe, expect, it, vi } from 'vitest'
import { withLiveDirectorySettingsColumnFallback } from '@/lib/db/streamers-safe-columns'

function missingColumnError(column: string) {
  return Object.assign(new Error(`column "${column}" does not exist`), {
    code: '42703',
  })
}

describe('withLiveDirectorySettingsColumnFallback', () => {
  it.each(['trade_enabled', 'cross_channel_trade_enabled'] as const)(
    '%s の未デプロイを検知すると安全な列集合で再試行する',
    async (column) => {
      const attempt = vi.fn(async (useSafeColumns: boolean) => {
        if (!useSafeColumns) throw missingColumnError(column)
        return 'safe-columns'
      })

      await expect(withLiveDirectorySettingsColumnFallback(attempt)).resolves.toBe('safe-columns')
      expect(attempt.mock.calls).toEqual([[false], [true]])
    },
  )

  it('対象外の 42703 は握りつぶさず再送出する', async () => {
    const error = missingColumnError('unrelated_column')
    const attempt = vi.fn(async () => {
      throw error
    })

    await expect(withLiveDirectorySettingsColumnFallback(attempt)).rejects.toBe(error)
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(attempt).toHaveBeenCalledWith(false)
  })
})
