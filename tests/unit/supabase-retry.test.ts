import { describe, it, expect, vi, beforeEach } from 'vitest'
import { withRetry } from '@/lib/supabase/retry'

// loggerモック
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

describe('withRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('成功時はリトライせずそのまま返す', async () => {
    const queryFn = vi.fn().mockResolvedValue({ data: 'ok', error: null })
    const result = await withRetry(queryFn, 'test')
    expect(result).toEqual({ data: 'ok', error: null })
    expect(queryFn).toHaveBeenCalledTimes(1)
  })

  it('リトライ不要なエラーは即座に返す', async () => {
    const queryFn = vi.fn().mockResolvedValue({
      status: 400,
      error: { message: 'Bad request', code: '400' },
    })
    const result = await withRetry(queryFn, 'test')
    expect(result.error!.message).toBe('Bad request')
    expect(queryFn).toHaveBeenCalledTimes(1)
  })

  it('result.status が 502 の場合リトライする', async () => {
    const queryFn = vi.fn()
      .mockResolvedValueOnce({
        status: 502,
        statusText: 'Bad Gateway',
        error: { message: 'Bad Gateway' },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: 'ok',
        error: null,
      })
    const result = await withRetry(queryFn, 'test', { delays: [0, 0, 0] })
    expect(result.error).toBeNull()
    expect(queryFn).toHaveBeenCalledTimes(2)
  })

  it('Cloudflare HTML 500 の場合リトライする', async () => {
    const queryFn = vi.fn()
      .mockResolvedValueOnce({
        status: 500,
        statusText: 'Internal Server Error',
        error: {
          message: '<html><head><title>500 Internal Server Error</title></head><body>cloudflare</body></html>',
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: 'ok',
        error: null,
      })
    const result = await withRetry(queryFn, 'test', { delays: [0, 0, 0] })
    expect(result.error).toBeNull()
    expect(queryFn).toHaveBeenCalledTimes(2)
  })

  it('result.status が 503 の場合リトライする', async () => {
    const queryFn = vi.fn()
      .mockResolvedValueOnce({
        status: 503,
        error: { message: 'Service Unavailable' },
      })
      .mockResolvedValueOnce({ data: 'ok', error: null })
    const result = await withRetry(queryFn, 'test', { delays: [0, 0, 0] })
    expect(result.error).toBeNull()
    expect(queryFn).toHaveBeenCalledTimes(2)
  })

  it('error.message にステータスコードが含まれる場合もリトライする（後方互換）', async () => {
    const queryFn = vi.fn()
      .mockResolvedValueOnce({
        error: { message: 'error code: 502' },
      })
      .mockResolvedValueOnce({ data: 'ok', error: null })
    const result = await withRetry(queryFn, 'test', { delays: [0, 0, 0] })
    expect(result.error).toBeNull()
    expect(queryFn).toHaveBeenCalledTimes(2)
  })

  it('Cloudflare 525 のエラーコードをリトライする', async () => {
    const queryFn = vi.fn()
      .mockResolvedValueOnce({
        error: { message: 'error code: 525' },
      })
      .mockResolvedValueOnce({ data: 'ok', error: null })
    const result = await withRetry(queryFn, 'getLicensePlan', { delays: [0, 0, 0] })
    expect(result.error).toBeNull()
    expect(queryFn).toHaveBeenCalledTimes(2)
  })

  it('SSL handshake failed メッセージをリトライする', async () => {
    const queryFn = vi.fn()
      .mockResolvedValueOnce({
        error: { message: 'SSL handshake failed' },
      })
      .mockResolvedValueOnce({ data: 'ok', error: null })
    const result = await withRetry(queryFn, 'test', { delays: [0, 0, 0] })
    expect(result.error).toBeNull()
    expect(queryFn).toHaveBeenCalledTimes(2)
  })

  it('テキストパターン "bad gateway" でもリトライする', async () => {
    const queryFn = vi.fn()
      .mockResolvedValueOnce({
        error: { message: 'Bad Gateway response from upstream' },
      })
      .mockResolvedValueOnce({ data: 'ok', error: null })
    const result = await withRetry(queryFn, 'test', { delays: [0, 0, 0] })
    expect(result.error).toBeNull()
    expect(queryFn).toHaveBeenCalledTimes(2)
  })

  it('最大リトライ回数を超えたらエラーを返す', async () => {
    const queryFn = vi.fn().mockResolvedValue({
      status: 502,
      error: { message: 'Bad Gateway' },
    })
    const result = await withRetry(queryFn, 'test', { maxRetries: 2, delays: [0, 0] })
    expect(result.error).not.toBeNull()
    // 初回 + 2回リトライ = 3回呼ばれる
    expect(queryFn).toHaveBeenCalledTimes(3)
  })

  it('result.status が 502 でも error.message にコードが無い場合にリトライする（Codex指摘対応）', async () => {
    // Codexが指摘した: HTTPステータスは502だがメッセージにコード番号なし
    const queryFn = vi.fn()
      .mockResolvedValueOnce({
        status: 502,
        statusText: 'Bad Gateway',
        error: { message: 'upstream connect error or disconnect/reset before headers' },
      })
      .mockResolvedValueOnce({ status: 200, data: 'ok', error: null })
    const result = await withRetry(queryFn, 'test', { delays: [0, 0, 0] })
    expect(result.error).toBeNull()
    expect(queryFn).toHaveBeenCalledTimes(2)
  })
})
