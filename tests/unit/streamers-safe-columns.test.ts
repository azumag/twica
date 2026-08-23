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

// 列オブジェクトを直接比較すると失敗時の差分が読みにくいため、
// Drizzle の投影キーと実SQL列名だけの対応表へ落として比較する。
// そのため、別テーブル由来でも同じSQL列名を持つ列オブジェクトへの差し替えまでは検知しない。
function toProjectionMap(columns: Record<string, { name: string }>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(columns).map(([key, column]) => [key, column.name]),
  )
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
    // 各列の検知経路自体は上の it.each で直接検証している。
    // `cross_channel_trade_enabled` は `trade_enabled` を部分文字列として含むため、
    // 検知テストだけでは前者の登録漏れを見逃しうる。ここで列集合そのものを固定する。
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
    // 下の完全一致テストでも検知できるが、デプロイ窓列の混入時に原因を直接示す
    // 診断用ガードとしてこの否定方向の契約も残す。
    const safeColumnNames = Object.values(STREAMERS_SAFE_COLUMNS).map((column) => column.name)

    for (const column of DEPLOY_WINDOW_COLUMNS) {
      expect(safeColumnNames).not.toContain(column)
    }
  })

  it('安全な列集合は streamers 全列からデプロイ窓対象だけを除いた投影キーと実SQL列の対応に一致する', () => {
    // schema に新列を追加してこのテストが失敗した場合は、その実SQL列が未デプロイの窓を
    // 持つなら *_SETTINGS_COLUMNS 側へ、既にデプロイ済みの通常列なら Drizzle の投影キーと
    // 対応する列オブジェクトを STREAMERS_SAFE_COLUMNS 側へ追加し、フォールバック時の返却行形状と
    // キー↔実SQL列の対応を維持する。
    const deployWindowColumnNames = new Set<string>(DEPLOY_WINDOW_COLUMNS)
    const expectedSafeColumns = Object.fromEntries(
      Object.entries(getTableColumns(streamersTable)).filter(
        ([, column]) => !deployWindowColumnNames.has(column.name),
      ),
    )
    const expectedSafeProjection = toProjectionMap(expectedSafeColumns)
    const safeProjection = toProjectionMap(STREAMERS_SAFE_COLUMNS)

    expect(safeProjection).toEqual(expectedSafeProjection)
  })
})
