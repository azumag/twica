import { describe, expect, it, vi } from 'vitest'
import { withLiveDirectorySettingsColumnFallback } from '@/lib/db/streamers-safe-columns'

function missingColumnError(column: string) {
  return Object.assign(new Error(`column "${column}" does not exist`), {
    code: '42703',
  })
}

describe('streamers trade settings deploy-window fallback', () => {
  it.each(['trade_enabled', 'cross_channel_trade_enabled'])(
    '%s の 42703 で安全列集合へ再試行する',
    async (column) => {
      const attempt = vi
        .fn()
        .mockRejectedValueOnce(missingColumnError(column))
        .mockResolvedValueOnce('safe-columns-result')

      await expect(withLiveDirectorySettingsColumnFallback(attempt)).resolves.toBe(
        'safe-columns-result'
      )
      expect(attempt).toHaveBeenNthCalledWith(1, false)
      expect(attempt).toHaveBeenNthCalledWith(2, true)
      expect(attempt).toHaveBeenCalledTimes(2)
    }
  )
})
