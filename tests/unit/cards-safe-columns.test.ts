/**
 * cards-safe-columns.ts の withCardsBattleColumnFallback 単体テスト (#685)
 *
 * isMissingCardsBattleColumnError / CARDS_SAFE_COLUMNS 自体は既存の
 * cards-route-driver-parity.test.ts / dashboard-data-driver-parity.test.ts が
 * 実クエリ経由で間接的に検証しているため、ここでは #685 で新設した
 * withCardsBattleColumnFallback の制御フロー（成功・フォールバック・再送出）
 * のみを、Drizzle モックを介さず直接テストする。
 */
import { describe, it, expect, vi } from 'vitest'
import { withCardsBattleColumnFallback } from '@/lib/db/cards-safe-columns'

function missingCardsBattleColumnError(column: string = 'hp') {
  return Object.assign(new Error(`column "${column}" of relation "cards" does not exist`), {
    code: '42703',
  })
}

describe('withCardsBattleColumnFallback', () => {
  it('初回試行が成功すればそのまま結果を返す（フォールバックは呼ばれない）', async () => {
    const attempt = vi.fn(async (useSafeColumns: boolean) =>
      useSafeColumns ? 'safe' : 'full'
    )

    const result = await withCardsBattleColumnFallback(attempt)

    expect(result).toBe('full')
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(attempt).toHaveBeenCalledWith(false)
  })

  it('本番未デプロイ8列由来のエラーなら useSafeColumns=true で再試行する', async () => {
    const attempt = vi.fn(async (useSafeColumns: boolean) => {
      if (!useSafeColumns) throw missingCardsBattleColumnError('hp')
      return 'safe'
    })

    const result = await withCardsBattleColumnFallback(attempt)

    expect(result).toBe('safe')
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(attempt).toHaveBeenNthCalledWith(1, false)
    expect(attempt).toHaveBeenNthCalledWith(2, true)
  })

  it('8列のいずれでもエラーを検知する', async () => {
    const columns = ['card_number', 'hp', 'atk', 'def', 'spd', 'skill_type', 'skill_name', 'skill_power']
    for (const column of columns) {
      const attempt = vi.fn(async (useSafeColumns: boolean) => {
        if (!useSafeColumns) throw missingCardsBattleColumnError(column)
        return 'safe'
      })
      await expect(withCardsBattleColumnFallback(attempt)).resolves.toBe('safe')
    }
  })

  it('本番未デプロイ8列に該当しないエラーはフォールバックせずそのまま再送出する', async () => {
    const permissionError = Object.assign(new Error('permission denied'), { code: '42501' })
    const attempt = vi.fn(async () => {
      throw permissionError
    })

    await expect(withCardsBattleColumnFallback(attempt)).rejects.toBe(permissionError)
    // 該当しないエラーでは2回目の再試行（useSafeColumns=true）を行わない
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('フォールバック後（useSafeColumns=true）の失敗はそのまま再送出する（三度目の試行はしない）', async () => {
    const fallbackError = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
    const attempt = vi.fn(async (useSafeColumns: boolean) => {
      if (!useSafeColumns) throw missingCardsBattleColumnError('hp')
      throw fallbackError
    })

    await expect(withCardsBattleColumnFallback(attempt)).rejects.toBe(fallbackError)
    expect(attempt).toHaveBeenCalledTimes(2)
  })
})
