import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logPerf, measurePerf, perfStart } from '@/lib/perf'

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
}))

vi.mock('@/lib/logger.server', () => ({
  logger: {
    info: mocks.info,
  },
}))

describe('perf helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('perfStartは現在時刻をそのまま返す', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_234)

    expect(perfStart()).toBe(1_234)
  })

  it('logPerfは経過時間とcontextをlogger.infoへ渡す', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_250)

    logPerf('dashboard', 'load', 1_200, { streamerId: 'streamer-1', cached: true })

    expect(mocks.info).toHaveBeenCalledWith(
      '[Perf] dashboard load 50ms',
      { streamerId: 'streamer-1', cached: true },
    )
  })

  it('logPerfはcontext未指定時に空objectを渡す', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_010)

    logPerf('plan', 'resolve', 2_000)

    expect(mocks.info).toHaveBeenCalledWith('[Perf] plan resolve 10ms', {})
  })

  it('measurePerfはtaskの戻り値を維持して計測ログを残す', async () => {
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(3_000)
      .mockReturnValueOnce(3_042)

    const result = await measurePerf(
      'bootstrap',
      'fetch',
      async () => 'ok',
      { source: 'test' },
    )

    expect(result).toBe('ok')
    expect(mocks.info).toHaveBeenCalledWith(
      '[Perf] bootstrap fetch 42ms',
      { source: 'test' },
    )
  })

  it('measurePerfはtask失敗時も計測ログを残して同じ例外を再throwする', async () => {
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(4_000)
      .mockReturnValueOnce(4_075)
    const error = new Error('task failed')

    await expect(measurePerf(
      'dashboard',
      'failed-load',
      async () => {
        throw error
      },
    )).rejects.toBe(error)

    expect(mocks.info).toHaveBeenCalledWith(
      '[Perf] dashboard failed-load 75ms',
      {},
    )
  })
})
