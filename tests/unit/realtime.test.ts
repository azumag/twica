import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { subscribeToGachaResults } from '@/lib/realtime'

const { createClientMock, loggerMock, reportRealtimeErrorMock } = vi.hoisted(() => ({
  createClientMock: vi.fn(),
  loggerMock: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  reportRealtimeErrorMock: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: createClientMock,
}))

vi.mock('@/lib/logger', () => ({
  logger: loggerMock,
}))

vi.mock('@/lib/sentry/error-handler', () => ({
  reportRealtimeError: reportRealtimeErrorMock,
}))

type StatusCallback = (status: string, err?: unknown) => void

describe('subscribeToGachaResults', () => {
  const statusCallbacks: StatusCallback[] = []
  const channels: Array<{
    on: ReturnType<typeof vi.fn>
    subscribe: ReturnType<typeof vi.fn>
  }> = []
  const client = {
    channel: vi.fn(),
    removeChannel: vi.fn(),
  }
  let randomSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    statusCallbacks.length = 0
    channels.length = 0
    client.channel.mockReset()
    client.removeChannel.mockReset()
    createClientMock.mockReturnValue(client)
    loggerMock.info.mockClear()
    loggerMock.warn.mockClear()
    loggerMock.error.mockClear()
    reportRealtimeErrorMock.mockClear()

    client.channel.mockImplementation(() => {
      const channel = {
        on: vi.fn(() => channel),
        subscribe: vi.fn((callback: StatusCallback) => {
          statusCallbacks.push(callback)
          return channel
        }),
      }
      channels.push(channel)
      return channel
    })
  })

  afterEach(() => {
    randomSpy.mockRestore()
    vi.useRealTimers()
  })

  it('keeps retrying by default for long-lived overlay subscriptions', async () => {
    const cleanup = subscribeToGachaResults('streamer-1', vi.fn(), {
      retryDelay: 10,
    })

    expect(channels).toHaveLength(1)

    for (let i = 0; i < 6; i++) {
      statusCallbacks[i]('CHANNEL_ERROR')
      await vi.runOnlyPendingTimersAsync()
    }

    expect(channels).toHaveLength(7)
    expect(loggerMock.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('Max retries'),
    )

    cleanup()
  })

  it('stops retrying when a finite maxRetries value is provided', async () => {
    const onError = vi.fn()
    const cleanup = subscribeToGachaResults('streamer-1', vi.fn(), {
      maxRetries: 1,
      retryDelay: 10,
      onError,
    })

    statusCallbacks[0]('CHANNEL_ERROR')
    await vi.runOnlyPendingTimersAsync()
    statusCallbacks[1]('CHANNEL_ERROR')
    await vi.runOnlyPendingTimersAsync()

    expect(channels).toHaveLength(2)
    expect(loggerMock.info).toHaveBeenCalledWith(
      'Max retries (1) reached for gacha:v2:streamer-1; staying on fallback path',
    )
    expect(onError).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: 'Realtime reconnect limit reached; polling fallback is active.',
        isExpected: true,
      }),
    )

    cleanup()
  })

  it('reports max retries only once when Supabase repeats terminal statuses', async () => {
    const onError = vi.fn()
    const cleanup = subscribeToGachaResults('streamer-1', vi.fn(), {
      maxRetries: 0,
      retryDelay: 10,
      onError,
    })

    statusCallbacks[0]('CHANNEL_ERROR')
    statusCallbacks[0]('CHANNEL_ERROR')
    await vi.runOnlyPendingTimersAsync()

    expect(loggerMock.info).toHaveBeenCalledWith(
      'Max retries (0) reached for gacha:v2:streamer-1; staying on fallback path',
    )
    expect(onError.mock.calls.filter(([error]) => (
      error.message === 'Realtime reconnect limit reached; polling fallback is active.'
    ))).toHaveLength(1)

    cleanup()
  })

  it('counts repeated terminal statuses with a pending retry as one failure', async () => {
    const onError = vi.fn()
    const cleanup = subscribeToGachaResults('streamer-1', vi.fn(), {
      maxRetries: 1,
      retryDelay: 10,
      onError,
    })

    statusCallbacks[0]('CHANNEL_ERROR')
    statusCallbacks[0]('CHANNEL_ERROR')
    await vi.runOnlyPendingTimersAsync()

    expect(channels).toHaveLength(2)
    expect(onError.mock.calls.filter(([error]) => (
      error.message === 'Realtime connection issue: CHANNEL_ERROR'
    ))).toHaveLength(1)
    expect(onError.mock.calls.some(([error]) => (
      error.message === 'Realtime reconnect limit reached; polling fallback is active.'
    ))).toBe(false)

    cleanup()
  })

  it('does not reconnect from stale callbacks after cleanup', async () => {
    const cleanup = subscribeToGachaResults('streamer-1', vi.fn(), {
      retryDelay: 10,
    })

    cleanup()
    statusCallbacks[0]('CHANNEL_ERROR')
    await vi.runOnlyPendingTimersAsync()

    expect(channels).toHaveLength(1)
    expect(client.removeChannel).toHaveBeenCalledTimes(1)
  })
})
