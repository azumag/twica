import { getTableColumns } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { streamers as streamersTable } from '@/lib/db/schema'
import {
  isMissingLiveDirectorySettingsColumnError,
  isMissingTradeSettingsColumnError,
  LIVE_DIRECTORY_SETTINGS_COLUMNS,
  STREAMERS_SAFE_COLUMNS,
  TRADE_SETTINGS_COLUMNS,
  withLiveDirectorySettingsColumnFallback,
} from '@/lib/db/streamers-safe-columns'

const DEPLOY_WINDOW_COLUMNS = [
  ...LIVE_DIRECTORY_SETTINGS_COLUMNS,
  ...TRADE_SETTINGS_COLUMNS,
] as const

function missingColumnError(column: string) {
  return Object.assign(new Error(`column "${column}" does not exist`), {
    code: '42703',
  })
}

describe('withLiveDirectorySettingsColumnFallback', () => {
  it.each(DEPLOY_WINDOW_COLUMNS)(
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

describe('streamers デプロイ窓の列集合契約', () => {
  it.each(LIVE_DIRECTORY_SETTINGS_COLUMNS)(
    '%s は live directory 設定列としてのみ検知する',
    (column) => {
      const error = missingColumnError(column)

      expect(isMissingLiveDirectorySettingsColumnError(error)).toBe(true)
      expect(isMissingTradeSettingsColumnError(error)).toBe(false)
    },
  )

  it.each(TRADE_SETTINGS_COLUMNS)('%s は trade 設定列としてのみ検知する', (column) => {
    const error = missingColumnError(column)

    expect(isMissingTradeSettingsColumnError(error)).toBe(true)
    expect(isMissingLiveDirectorySettingsColumnError(error)).toBe(false)
  })

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

  it('安全な列集合にはデプロイ窓で欠落しうる実SQL列を含めない', () => {
    const safeColumnNames = Object.values(STREAMERS_SAFE_COLUMNS).map((column) => column.name)

    for (const column of DEPLOY_WINDOW_COLUMNS) {
      expect(safeColumnNames).not.toContain(column)
    }
  })

  it('安全な列集合は streamers 全列からデプロイ窓対象だけを除いた集合と一致する', () => {
    const deployWindowColumnNames = new Set<string>(DEPLOY_WINDOW_COLUMNS)
    const allColumnNames = Object.values(getTableColumns(streamersTable)).map((column) => column.name)
    const expectedSafeColumnNames = allColumnNames.filter(
      (column) => !deployWindowColumnNames.has(column),
    )
    const safeColumnNames = Object.values(STREAMERS_SAFE_COLUMNS).map((column) => column.name)

    expect([...safeColumnNames].sort()).toEqual([...expectedSafeColumnNames].sort())
  })
})
