import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { isRetryableDbError, withDbRetry } from '@/lib/db/retry'
import { logger } from '@/lib/logger'

// loggerモック（supabase-retry.test.ts と同じスタイル）
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

/** postgres.js が throw するエラー（code プロパティ付き）を模倣する */
function pgError(code: string, message = `error ${code}`): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

describe('isRetryableDbError', () => {
  it.each([
    'CONNECTION_CLOSED',
    'CONNECTION_ENDED',
    'CONNECTION_DESTROYED',
    'CONNECT_TIMEOUT',
  ])('postgres.js の接続断系コード %s はリトライ対象', (code) => {
    expect(isRetryableDbError(pgError(code))).toBe(true)
  })

  it.each(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE'])(
    'Node のソケット系コード %s はリトライ対象',
    (code) => {
      expect(isRetryableDbError(pgError(code))).toBe(true)
    }
  )

  it.each(['57P01', '57P02', '57P03', '53300', '08006', '08001', '08003'])(
    'PG 一時障害系 SQLSTATE %s はリトライ対象',
    (code) => {
      expect(isRetryableDbError(pgError(code))).toBe(true)
    }
  )

  it('Workers のリクエストスコープ破棄エラー（メッセージで識別）はリトライ対象', () => {
    expect(
      isRetryableDbError(
        new Error('Cannot perform I/O on behalf of a different request')
      )
    ).toBe(true)
  })

  it.each([
    ['23505 unique_violation（恒久的エラー）', pgError('23505')],
    ['42703 undefined_column（恒久的エラー）', pgError('42703')],
    ['code なしの一般 Error', new Error('boom')],
    ['数値 code', Object.assign(new Error('x'), { code: 57 })],
  ])('%s はリトライ対象外', (_label, error) => {
    expect(isRetryableDbError(error)).toBe(false)
  })

  it('unknown 安全性: null / undefined / 文字列を食わせても false', () => {
    expect(isRetryableDbError(null)).toBe(false)
    expect(isRetryableDbError(undefined)).toBe(false)
    expect(isRetryableDbError('CONNECTION_CLOSED')).toBe(false)
  })
})

describe('withDbRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('成功時はリトライせずそのまま返す', async () => {
    const queryFn = vi.fn().mockResolvedValue([{ id: '1' }])
    const result = await withDbRetry(queryFn, 'test', { idempotent: true })
    expect(result).toEqual([{ id: '1' }])
    expect(queryFn).toHaveBeenCalledTimes(1)
  })

  it('非冪等（既定）は接続断エラーでもリトライせず即 throw する', async () => {
    const error = pgError('CONNECTION_CLOSED')
    const queryFn = vi.fn().mockRejectedValue(error)
    await expect(withDbRetry(queryFn, 'test')).rejects.toBe(error)
    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('idempotent: true なら接続断エラーでリトライし、回復したら値を返す', async () => {
    const queryFn = vi
      .fn()
      .mockRejectedValueOnce(pgError('CONNECTION_CLOSED'))
      .mockResolvedValueOnce([{ id: '1' }])
    const result = await withDbRetry(queryFn, 'test', {
      idempotent: true,
      delays: [0, 0, 0],
    })
    expect(result).toEqual([{ id: '1' }])
    expect(queryFn).toHaveBeenCalledTimes(2)
    // ログに [db:pg] 観測タグが付くこと
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[db:pg] test failed (attempt 1/4)'),
      expect.objectContaining({ code: 'CONNECTION_CLOSED' })
    )
  })

  it('idempotent: true でも恒久的エラー（23505）は即 throw する', async () => {
    const error = pgError('23505')
    const queryFn = vi.fn().mockRejectedValue(error)
    await expect(
      withDbRetry(queryFn, 'test', { idempotent: true, delays: [0, 0, 0] })
    ).rejects.toBe(error)
    expect(queryFn).toHaveBeenCalledTimes(1)
  })

  it('cross-request I/O エラーは idempotent: true でリトライされる', async () => {
    const queryFn = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('Cannot perform I/O on behalf of a different request')
      )
      .mockResolvedValueOnce('ok')
    const result = await withDbRetry(queryFn, 'test', {
      idempotent: true,
      delays: [0],
    })
    expect(result).toBe('ok')
    expect(queryFn).toHaveBeenCalledTimes(2)
  })

  it('maxRetries に到達したら最後のエラーを throw する（初回 + maxRetries 回）', async () => {
    const error = pgError('ECONNRESET')
    const queryFn = vi.fn().mockRejectedValue(error)
    await expect(
      withDbRetry(queryFn, 'test', {
        idempotent: true,
        maxRetries: 2,
        delays: [0, 0],
      })
    ).rejects.toBe(error)
    expect(queryFn).toHaveBeenCalledTimes(3)
  })

  it('既定の delays は [100, 300, 1000]（supabase/retry.ts と同一）で進行する', async () => {
    vi.useFakeTimers()
    const queryFn = vi.fn().mockRejectedValue(pgError('CONNECTION_CLOSED'))
    const promise = withDbRetry(queryFn, 'test', { idempotent: true })
    // rejection を先に捕捉しておく（unhandled rejection 防止）
    const settled = promise.catch((e: unknown) => e)

    // 初回失敗まで進める
    await vi.advanceTimersByTimeAsync(0)
    expect(queryFn).toHaveBeenCalledTimes(1)

    // 100ms 後に 2 回目
    await vi.advanceTimersByTimeAsync(100)
    expect(queryFn).toHaveBeenCalledTimes(2)

    // さらに 300ms 後に 3 回目
    await vi.advanceTimersByTimeAsync(300)
    expect(queryFn).toHaveBeenCalledTimes(3)

    // さらに 1000ms 後に 4 回目（初回 + 3 リトライで打ち切り）
    await vi.advanceTimersByTimeAsync(1000)
    expect(queryFn).toHaveBeenCalledTimes(4)

    const result = await settled
    expect(result).toMatchObject({ code: 'CONNECTION_CLOSED' })
  })

  it('delays より attempt が多い場合は最後の delay を使い続ける', async () => {
    const queryFn = vi
      .fn()
      .mockRejectedValueOnce(pgError('CONNECTION_CLOSED'))
      .mockRejectedValueOnce(pgError('CONNECTION_CLOSED'))
      .mockResolvedValueOnce('ok')
    // delays 1 要素 + maxRetries 2 → 2 回目のリトライも delays[0] を使う
    const result = await withDbRetry(queryFn, 'test', {
      idempotent: true,
      maxRetries: 2,
      delays: [0],
    })
    expect(result).toBe('ok')
    expect(queryFn).toHaveBeenCalledTimes(3)
  })
})
