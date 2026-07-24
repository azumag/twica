import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  subscribeToGachaResults as subscribeToGachaResultsTransport,
  type GachaBroadcastPayload,
  type SubscribeOptions,
} from '@/lib/realtime'
import { buildPollingRealtimeEvents } from '@/lib/overlay-realtime/contract'

const STREAMER_ID = '123e4567-e89b-42d3-a456-426614174000'

function subscribeToGachaResults(
  _streamerId: string,
  callback: (payload: GachaBroadcastPayload) => void,
  options?: SubscribeOptions
): () => void {
  return subscribeToGachaResultsTransport(STREAMER_ID, callback, options)
}

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
    sessionStorage.clear()
    // A rejected fetch would otherwise enter happy-dom's real XHR fallback.
    // Individual compatibility coverage for XHR lives in the overlay page tests.
    vi.stubGlobal('XMLHttpRequest', undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
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
      soundGroupId: 'event-1',
      historyCursor: redeemedAt,
    })
    expect(callback.mock.calls[1][0]).toMatchObject({
      type: 'gacha',
      card: CARD_A,
      userTwitchUsername: 'DemoUser',
    })
    expect(callback.mock.calls[1][0]).not.toHaveProperty('historyCursor')
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/events?'))).toBe(true)
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/demo-events?'))).toBe(true)

    cleanup()
  })

  it('keeps the supported 15-draw maximum in one callback and one sound batch', async () => {
    const redeemedAt = '2026-07-24T00:00:01.000Z'
    const events = Array.from({ length: 15 }, (_, index) => ({
      id: `history-${index + 1}`,
      eventId: index === 0 ? 'event-15' : `event-15:${index + 1}`,
      redeemedAt,
      userTwitchUsername: 'viewer',
      rewardId: 'reward-1',
      card: { ...CARD_A, id: `card-${index + 1}` },
    }))
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/demo-events')
        ? jsonResponse({ event: null })
        : jsonResponse({ events })
    ))

    const callback = vi.fn()
    const cleanup = subscribeToGachaResults('streamer-1', callback)
    await flushPromises()

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback.mock.calls[0][0].cards).toHaveLength(15)
    expect(callback.mock.calls[0][0].historyCursor).toBe(redeemedAt)
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

  it('does not duplicate an HTTP error through the XHR compatibility path', async () => {
    const xhrConstructor = vi.fn()
    vi.stubGlobal('XMLHttpRequest', xhrConstructor)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: vi.fn(),
    } as unknown as Response))

    const cleanup = subscribeToGachaResults('streamer-1', vi.fn(), { retryDelay: 10 })
    await flushPromises()

    expect(xhrConstructor).not.toHaveBeenCalled()
    cleanup()
  })

  it('deduplicates the same committed draw across WebSocket and polling recovery', async () => {
    class FakeWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSING = 2
      static readonly CLOSED = 3
      static readonly instances: FakeWebSocket[] = []
      readyState = FakeWebSocket.CONNECTING
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      onclose: ((event: { code: number }) => void) | null = null
      sent: string[] = []

      constructor(readonly url: string) {
        FakeWebSocket.instances.push(this)
        queueMicrotask(() => {
          this.readyState = FakeWebSocket.OPEN
          this.onopen?.()
        })
      }

      send(message: string) {
        this.sent.push(message)
      }

      close(code = 1000) {
        this.readyState = FakeWebSocket.CLOSED
        this.onclose?.({ code })
      }

      emit(event: unknown) {
        this.onmessage?.({ data: JSON.stringify(event) })
      }
    }
    vi.stubGlobal('WebSocket', FakeWebSocket)

    const pollingRow = {
      id: 'history-ws-1',
      eventId: 'batch-ws-1',
      redeemedAt: '2026-07-24T00:00:01.000Z',
      userTwitchUsername: 'viewer',
      rewardId: null,
      card: CARD_A,
    }
    const [event] = buildPollingRealtimeEvents(STREAMER_ID, [pollingRow])
    let historyCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/realtime-config')) {
        return jsonResponse({
          schemaVersion: 1,
          mode: 'do-primary',
          webSocketUrl: 'https://realtime.example',
          protocolVersion: 1,
          retryPolicy: { baseDelayMs: 100, maxDelayMs: 1_000 },
          configVersion: 'test-v1',
        })
      }
      if (url.includes('/demo-events')) return jsonResponse({ event: null })
      historyCalls += 1
      return jsonResponse({
        events: historyCalls === 1 ? [] : [pollingRow],
      })
    }))

    const callback = vi.fn()
    const statuses: string[] = []
    const cleanup = subscribeToGachaResults('ignored', callback, {
      retryDelay: 10,
      onStatusChange: (status) => statuses.push(status),
    })
    await flushPromises()

    expect(FakeWebSocket.instances).toHaveLength(1)
    FakeWebSocket.instances[0].emit({ type: 'gacha_result', event })
    await vi.advanceTimersByTimeAsync(10)
    await flushPromises()

    expect(callback).toHaveBeenCalledTimes(1)
    expect(statuses).toContain('DO_CONNECTED')
    expect(
      statuses.some((status) => status.startsWith('DUPLICATE_EVENT:'))
    ).toBe(true)
    cleanup()
  })

  it('does not start a second polling request while reconnect recovery is in flight', async () => {
    class OpeningWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSING = 2
      readyState = OpeningWebSocket.CONNECTING
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      onclose: ((event: { code: number }) => void) | null = null

      constructor() {
        queueMicrotask(() => {
          this.readyState = OpeningWebSocket.OPEN
          this.onopen?.()
        })
      }

      send() {}
      close() {
        this.readyState = 3
      }
    }
    vi.stubGlobal('WebSocket', OpeningWebSocket)

    let historyCalls = 0
    let resolveHistory!: (response: Response) => void
    const pendingHistory = new Promise<Response>((resolve) => {
      resolveHistory = resolve
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/realtime-config')) {
        return jsonResponse({
          schemaVersion: 1,
          mode: 'do-primary',
          webSocketUrl: 'https://realtime.example',
          protocolVersion: 1,
          retryPolicy: { baseDelayMs: 100, maxDelayMs: 1_000 },
          configVersion: 'test-v1',
        })
      }
      if (url.includes('/demo-events')) return jsonResponse({ event: null })
      historyCalls += 1
      return historyCalls === 1 ? pendingHistory : jsonResponse({ events: [] })
    }))

    const cleanup = subscribeToGachaResults('ignored', vi.fn(), {
      retryDelay: 10,
    })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()

    expect(historyCalls).toBe(1)
    resolveHistory(jsonResponse({ events: [] }))
    await flushPromises()
    cleanup()
  })

  it('ignores stale socket callbacks after the configured endpoint changes', async () => {
    class ControlledWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSING = 2
      static readonly instances: ControlledWebSocket[] = []
      readyState = ControlledWebSocket.CONNECTING
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      onclose: ((event: { code: number }) => void) | null = null

      constructor(readonly url: string) {
        ControlledWebSocket.instances.push(this)
        // Complete the connection before its 10-second timeout. The test is
        // about the 30-second config refresh; leaving sockets CONNECTING would
        // correctly exercise timeout/reconnect cycles and make the instance
        // count depend on unrelated backoff timing.
        queueMicrotask(() => {
          this.readyState = ControlledWebSocket.OPEN
          this.onopen?.()
        })
      }

      send() {}
      close(code = 1000) {
        this.readyState = 3
        this.onclose?.({ code })
      }
      emit(event: unknown) {
        this.onmessage?.({ data: JSON.stringify(event) })
      }
    }
    vi.stubGlobal('WebSocket', ControlledWebSocket)
    vi.spyOn(Math, 'random').mockReturnValue(0)

    let configCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/realtime-config')) {
        configCalls += 1
        return jsonResponse({
          schemaVersion: 1,
          mode: 'do-primary',
          webSocketUrl:
            configCalls === 1
              ? 'https://realtime-a.example'
              : 'https://realtime-b.example',
          protocolVersion: 1,
          retryPolicy: { baseDelayMs: 100, maxDelayMs: 1_000 },
          configVersion: `test-v${configCalls}`,
        })
      }
      if (url.includes('/demo-events')) return jsonResponse({ event: null })
      return jsonResponse({ events: [] })
    }))

    const [event] = buildPollingRealtimeEvents(STREAMER_ID, [{
      id: 'history-stale-1',
      eventId: 'batch-stale-1',
      redeemedAt: '2026-07-24T00:00:01.000Z',
      userTwitchUsername: 'viewer',
      card: CARD_A,
    }])
    const callback = vi.fn()
    const statuses: string[] = []
    const cleanup = subscribeToGachaResults('ignored', callback, {
      retryDelay: 1_000_000,
      onStatusChange: (status) => statuses.push(status),
    })
    await flushPromises()
    expect(ControlledWebSocket.instances).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(30_000)
    await flushPromises()
    expect(ControlledWebSocket.instances).toHaveLength(2)

    ControlledWebSocket.instances[0].emit({ type: 'gacha_result', event })
    expect(callback).not.toHaveBeenCalled()
    ControlledWebSocket.instances[1].emit({ type: 'gacha_result', event })
    expect(callback).toHaveBeenCalledTimes(1)

    ControlledWebSocket.instances[1].onclose?.({ code: 1006 })
    // A config endpoint change starts a fresh connection policy, so the next
    // outage uses the initial half-jitter delay (random is stubbed to zero).
    expect(statuses).toContain('DO_RECONNECT_WAIT:50')
    cleanup()
  })

  it('keeps one sound group when a bounded backlog splits one batch across pages', async () => {
    const firstRows = [1, 2].map((drawNumber) => ({
      id: `history-split-${drawNumber}`,
      eventId:
        drawNumber === 1 ? 'batch-split' : `batch-split:${drawNumber}`,
      redeemedAt: '2026-07-24T00:00:01.000Z',
      userTwitchUsername: 'viewer',
      card: { ...CARD_A, id: `card-${drawNumber}` },
    }))
    const secondRows = [3, 4].map((drawNumber) => ({
      id: `history-split-${drawNumber}`,
      eventId: `batch-split:${drawNumber}`,
      redeemedAt: '2026-07-24T00:00:01.000Z',
      userTwitchUsername: 'viewer',
      card: { ...CARD_A, id: `card-${drawNumber}` },
    }))
    const pages = [
      buildPollingRealtimeEvents(STREAMER_ID, firstRows),
      buildPollingRealtimeEvents(STREAMER_ID, secondRows),
    ]
    let historyCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/realtime-config')) {
        return jsonResponse({
          schemaVersion: 1,
          mode: 'polling-only',
          protocolVersion: 1,
          retryPolicy: { baseDelayMs: 100, maxDelayMs: 1_000 },
          configVersion: 'polling-test',
        })
      }
      if (String(input).includes('/demo-events')) {
        return jsonResponse({ event: null })
      }
      const page = pages[Math.min(historyCalls, pages.length - 1)]
      historyCalls += 1
      return jsonResponse({ realtimeEvents: page })
    }))

    const callback = vi.fn()
    const cleanup = subscribeToGachaResults('ignored', callback, {
      retryDelay: 10,
    })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(10)
    await flushPromises()

    expect(callback).toHaveBeenCalledTimes(2)
    expect(callback.mock.calls.map(([payload]) => payload.soundGroupId)).toEqual([
      'batch-split',
      'batch-split',
    ])
    expect(
      callback.mock.calls.flatMap(([payload]) =>
        (payload.cards ?? [payload.card]).map(
          (card: GachaBroadcastPayload['card']) => card.id
        )
      )
    ).toEqual(['card-1', 'card-2', 'card-3', 'card-4'])
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
    expect(fetchMock).toHaveBeenCalledTimes(3)

    cleanup()
    await vi.advanceTimersByTimeAsync(100)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
