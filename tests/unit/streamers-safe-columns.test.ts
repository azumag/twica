import { describe, expect, it, vi } from 'vitest'
import {
  LIVE_DIRECTORY_SETTINGS_COLUMNS,
  STREAMERS_SAFE_COLUMNS,
  TRADE_SETTINGS_COLUMNS,
  withLiveDirectorySettingsColumnFallback,
} from '@/lib/db/streamers-safe-columns'

function missingColumnError(column: string) {
  return Object.assign(new Error(`column "${column}" does not exist`), {
    code: '42703',
  })
}

describe('withLiveDirectorySettingsColumnFallback', () => {
  it.each([...LIVE_DIRECTORY_SETTINGS_COLUMNS, ...TRADE_SETTINGS_COLUMNS])(
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

  it('デプロイ窓の対象列集合を明示的に固定する', () => {
    // isPgMissingNamedColumnError はエラーテキストの部分一致も利用するため、
    // cross_channel_trade_enabled が trade_enabled の一致だけで偶然通る回帰を防ぐ。
    expect(LIVE_DIRECTORY_SETTINGS_COLUMNS).toEqual([
      'publish_live_status',
      'publish_stats',
    ])
    expect(TRADE_SETTINGS_COLUMNS).toEqual([
      'trade_enabled',
      'cross_channel_trade_enabled',
    ])
  })

  it('安全な列集合にはデプロイ窓で欠落しうる列を含めない', () => {
    const safeColumnNames = Object.keys(STREAMERS_SAFE_COLUMNS)

    for (const column of [...LIVE_DIRECTORY_SETTINGS_COLUMNS, ...TRADE_SETTINGS_COLUMNS]) {
      expect(safeColumnNames).not.toContain(column)
    }
  })

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
