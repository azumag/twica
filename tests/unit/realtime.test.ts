import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { subscribeToGachaResults } from '@/lib/realtime'

const CARD_A = {
  id: 'card-a',
  name: 'A',
  description: null,
  image_url: null,
  rarity: 'common',
}
const CARD_B = { ...CARD_A, id: 'card-b', name: 'B' }

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve()
  }
}

describe('subscribeToGachaResults: HTTP polling transport', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // A rejected fetch would otherwise enter happy-dom's real XHR fallback.
    // Individual compatibility coverage for XHR lives in the overlay page tests.
    vi.stubGlobal('XMLHttpRequest', undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('groups N-draw history rows and consumes a separate demo event', async () => {
    const redeemedAt = '2026-07-24T00:00:01.000Z'
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/demo-events')) {
        return jsonResponse({
          event: {
            id: 'demo:1',
            eventId: 'demo:1',
            redeemedAt: '2026-07-24T00:00:02.000Z',
            userTwitchUsername: 'DemoUser',
            rewardId: null,
            card: CARD_A,
          },
        })
      }
      return jsonResponse({
        events: [
          {
            id: 'history-1',
            eventId: 'event-1',
            redeemedAt,
            userTwitchUsername: 'viewer',
            rewardId: 'reward-1',
            card: CARD_A,
          },
          {
            id: 'history-2',
            eventId: 'event-1:2',
            redeemedAt,
            userTwitchUsername: 'viewer',
            rewardId: 'reward-1',
            card: CARD_B,
          },
        ],
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const callback = vi.fn()
    const onSuccess = vi.fn()
    const cleanup = subscribeToGachaResults('streamer-1', callback, {
      retryDelay: 1000,
      onSuccess,
    })
    await flushPromises()

    expect(onSuccess).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledTimes(2)
    expect(callback.mock.calls[0][0]).toEqual({
      type: 'gacha',
      card: CARD_A,
      cards: [CARD_A, CARD_B],
      userTwitchUsername: 'viewer',
      rewardId: 'reward-1',
    })
    expect(callback.mock.calls[1][0]).toMatchObject({
      type: 'gacha',
      card: CARD_A,
      userTwitchUsername: 'DemoUser',
    })
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/events?'))).toBe(true)
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/demo-events?'))).toBe(true)

    cleanup()
  })

  it('deduplicates rows returned again by a subsequent poll', async () => {
    const event = {
      id: 'history-1',
      eventId: 'event-1',
      redeemedAt: '2026-07-24T00:00:01.000Z',
      userTwitchUsername: 'viewer',
      rewardId: null,
      card: CARD_A,
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/demo-events')
        ? jsonResponse({ event: null })
        : jsonResponse({ events: [event] })
    ))

    const callback = vi.fn()
    const cleanup = subscribeToGachaResults('streamer-1', callback, { retryDelay: 10 })
    await flushPromises()
    expect(callback).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(10)
    await flushPromises()
    expect(callback).toHaveBeenCalledTimes(1)

    cleanup()
  })

  it('retries transient failures without switching to a second cursor owner', async () => {
    let historyAttempts = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/demo-events')) return jsonResponse({ event: null })
      historyAttempts += 1
      if (historyAttempts === 1) throw new Error('temporary network error')
      return jsonResponse({ events: [] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const onError = vi.fn()
    const onSuccess = vi.fn()
    const onStatusChange = vi.fn()
    const cleanup = subscribeToGachaResults('streamer-1', vi.fn(), {
      retryDelay: 10,
      onError,
      onSuccess,
      onStatusChange,
    })
    await flushPromises()

    expect(onError).not.toHaveBeenCalled()
    expect(onStatusChange).toHaveBeenCalledWith('POLLING_RETRY:1')

    await vi.advanceTimersByTimeAsync(10)
    await flushPromises()
    expect(onSuccess).toHaveBeenCalledTimes(1)

    cleanup()
  })

  it('reports an error only after an explicitly finite retry limit is exhausted', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/demo-events')) return jsonResponse({ event: null })
      throw new Error('offline')
    }))

    const onError = vi.fn()
    const cleanup = subscribeToGachaResults('streamer-1', vi.fn(), {
      maxRetries: 1,
      retryDelay: 10,
      onError,
    })
    await flushPromises()
    expect(onError).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(10)
    await flushPromises()
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Overlay polling retry limit reached',
        isExpected: false,
      })
    )

    cleanup()
  })

  it('cleanup cancels future polling', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/demo-events')
        ? jsonResponse({ event: null })
        : jsonResponse({ events: [] })
    )
    vi.stubGlobal('fetch', fetchMock)

    const cleanup = subscribeToGachaResults('streamer-1', vi.fn(), { retryDelay: 10 })
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledTimes(2)

    cleanup()
    await vi.advanceTimersByTimeAsync(100)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
