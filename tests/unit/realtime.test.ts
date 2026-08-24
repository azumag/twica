import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  subscribeToGachaResults as subscribeToGachaResultsTransport,
  type GachaBroadcastPayload,
  type SubscribeOptions,
} from '@/lib/realtime'
import {
  MAX_OVERLAY_VERSION_LENGTH,
  buildPollingRealtimeEvents,
} from '@/lib/overlay-realtime/contract'
import {
  resolveOverlayRealtimeConfig,
  resolveOverlayRealtimeConfigVersion,
} from '@/lib/overlay-realtime/resolve-config'

const STREAMER_ID = '123e4567-e89b-42d3-a456-426614174000'

function historyUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
}

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
  image_padding_color: null,
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
    localStorage.clear()
    window.history.replaceState({}, '', '/')
    // A rejected fetch would otherwise enter happy-dom's real XHR fallback.
    // Individual compatibility coverage for XHR lives in the overlay page tests.
    vi.stubGlobal('XMLHttpRequest', undefined)
  })

  afterEach(() => {
    window.history.replaceState({}, '', '/')
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('groups N-draw history rows and consumes a demo from the same polling response', async () => {
    const redeemedAt = '2026-07-24T00:00:01.000Z'
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      // Preserve the argument tuple for URL assertions below; the response is
      // intentionally identical for config and events in this grouping test.
      void input
      return jsonResponse({
        events: [
          {
            id: historyUuid(1),
            eventId: 'event-1',
            redeemedAt,
            userTwitchUsername: 'viewer',
            rewardId: 'reward-1',
            card: CARD_A,
          },
          {
            id: historyUuid(2),
            eventId: 'event-1:2',
            redeemedAt,
            userTwitchUsername: 'viewer',
            rewardId: 'reward-1',
            card: CARD_B,
          },
        ],
        demoEvent: {
          id: 'demo:1',
          eventId: 'demo:1',
          redeemedAt: '2026-07-24T00:00:02.000Z',
          userTwitchUsername: 'DemoUser',
          rewardId: null,
          card: CARD_A,
        },
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
      drawEventIds: ['event-1', 'event-1:2'],
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
    const pollingUrl = String(fetchMock.mock.calls[0][0])
    expect(pollingUrl).toContain('/events?')
    expect(pollingUrl).toContain('demoSince=')
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/demo-events'))).toBe(false)

    cleanup()
  })

  it('starts recovery from the restored exact cursor and keeps same-time rows ordered', async () => {
    const restoredAt = '2026-07-24T00:00:01.000Z'
    const restoredId = historyUuid(10)
    const rows = [
      {
        id: historyUuid(11),
        eventId: 'event-same-time-2',
        redeemedAt: restoredAt,
        userTwitchUsername: 'viewer',
        card: CARD_A,
      },
      {
        id: historyUuid(12),
        eventId: 'event-same-time-3',
        redeemedAt: restoredAt,
        userTwitchUsername: 'viewer',
        card: CARD_B,
      },
    ]
    const requestedEventUrls: URL[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.includes('/realtime-config')) {
        return jsonResponse({
          schemaVersion: 1,
          mode: 'polling-only',
          protocolVersion: 1,
          retryPolicy: { baseDelayMs: 100, maxDelayMs: 1_000 },
          configVersion: 'polling-v1',
          overlayVersion: 'build-current',
        })
      }
      requestedEventUrls.push(url)
      return jsonResponse({
        realtimeEvents: buildPollingRealtimeEvents(STREAMER_ID, rows),
        nextCursor: { redeemedAt: restoredAt, historyId: rows[1].id },
      })
    }))

    const callback = vi.fn()
    const onHistoryCursor = vi.fn()
    const cleanup = subscribeToGachaResults('ignored', callback, {
      initialHistoryCursor: { redeemedAt: restoredAt, historyId: restoredId },
      onHistoryCursor,
    })
    await flushPromises()

    expect(requestedEventUrls[0].searchParams.get('since')).toBe(restoredAt)
    expect(requestedEventUrls[0].searchParams.get('afterId')).toBe(restoredId)
    expect(callback.mock.calls.map(([payload]) => payload.card.id)).toEqual([
      CARD_A.id,
      CARD_B.id,
    ])
    expect(onHistoryCursor).toHaveBeenLastCalledWith({
      redeemedAt: restoredAt,
      historyId: rows[1].id,
    })
    cleanup()
  })

  it('notifies bounded overlay versions from both valid config and events responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/realtime-config')) {
        return jsonResponse({
          schemaVersion: 1,
          mode: 'polling-only',
          protocolVersion: 1,
          retryPolicy: { baseDelayMs: 100, maxDelayMs: 1_000 },
          configVersion: 'polling-v1',
          overlayVersion: 'build-from-config',
        })
      }
      return jsonResponse({
        events: [],
        overlayVersion: 'build-from-events',
      })
    }))

    const onOverlayVersion = vi.fn()
    const cleanup = subscribeToGachaResults('streamer-1', vi.fn(), {
      onOverlayVersion,
    })
    await flushPromises()

    expect(onOverlayVersion).toHaveBeenCalledTimes(2)
    expect(onOverlayVersion.mock.calls.map(([version]) => version)).toEqual(
      expect.arrayContaining(['build-from-config', 'build-from-events'])
    )
    cleanup()
  })

  it('does not notify from an invalid config, its safe fallback, or an unbounded events value', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/realtime-config')) {
        return jsonResponse({
          schemaVersion: 1,
          mode: 'polling-only',
          protocolVersion: 1,
          retryPolicy: { baseDelayMs: 100, maxDelayMs: 1_000 },
          // The config itself is invalid even though overlayVersion is valid:
          // unbounded configVersion must fail the complete response contract.
          configVersion: 'c'.repeat(129),
          // A valid-looking auxiliary value must not escape an otherwise
          // invalid response before the safe fallback is selected.
          overlayVersion: 'must-not-notify',
        })
      }
      return jsonResponse({
        events: [],
        overlayVersion: 'v'.repeat(MAX_OVERLAY_VERSION_LENGTH + 1),
      })
    }))

    const onOverlayVersion = vi.fn()
    const onStatusChange = vi.fn()
    const cleanup = subscribeToGachaResults('streamer-1', vi.fn(), {
      onOverlayVersion,
      onStatusChange,
    })
    await flushPromises()

    expect(onOverlayVersion).not.toHaveBeenCalled()
    expect(onStatusChange).toHaveBeenCalledWith('CONFIG_FALLBACK:POLLING_ONLY')
    cleanup()
  })

  it('advances only demoSince when a demo arrives without committed history', async () => {
    const demoRedeemedAt = '2026-07-24T00:00:02.000Z'
    const pollingUrls: URL[] = []
    let pollingCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/realtime-config')) {
        return jsonResponse({
          schemaVersion: 1,
          mode: 'polling-only',
          protocolVersion: 1,
          retryPolicy: { baseDelayMs: 100, maxDelayMs: 1_000 },
          configVersion: 'test-v1',
        })
      }
      pollingUrls.push(url)
      pollingCalls += 1
      return jsonResponse({
        events: [],
        nextCursor: null,
        demoEvent: pollingCalls === 1
          ? {
              id: 'demo:only',
              eventId: 'demo:only',
              redeemedAt: demoRedeemedAt,
              userTwitchUsername: 'DemoUser',
              rewardId: null,
              card: CARD_A,
            }
          : null,
      })
    }))

    const callback = vi.fn()
    const cleanup = subscribeToGachaResults('streamer-1', callback, {
      retryDelay: 10,
    })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(10)
    await flushPromises()

    expect(pollingUrls).toHaveLength(2)
    expect(pollingUrls[1].searchParams.get('since')).toBe(
      pollingUrls[0].searchParams.get('since')
    )
    expect(pollingUrls[1].searchParams.has('afterId')).toBe(false)
    expect(pollingUrls[1].searchParams.get('demoSince')).toBe(demoRedeemedAt)
    expect(callback).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('bounds polling demo callback failures without slowing history recovery forever', async () => {
    const demoEvent = {
      id: 'demo:polling-retry-limit',
      eventId: 'demo:polling-retry-limit',
      redeemedAt: '2026-07-24T00:00:02.000Z',
      userTwitchUsername: 'DemoUser',
      rewardId: null,
      card: CARD_A,
    }
    const statuses: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/realtime-config')) {
        return jsonResponse({
          schemaVersion: 1,
          mode: 'polling-only',
          protocolVersion: 1,
          retryPolicy: { baseDelayMs: 10, maxDelayMs: 1_000 },
          configVersion: 'polling-demo-retry-limit-v1',
        })
      }
      return jsonResponse({
        events: [],
        nextCursor: null,
        demoEvent,
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const callback = vi.fn(() => false)
    const cleanup = subscribeToGachaResults('streamer-1', callback, {
      retryDelay: 10,
      onStatusChange: (status) => statuses.push(status),
    })
    await flushPromises()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Polling retry delay is exponential (10, 20, 40ms), so advance to the
      // next scheduled retry rather than assuming a fixed interval.
      await vi.advanceTimersToNextTimerAsync()
      await flushPromises()
    }

    expect(callback).toHaveBeenCalledTimes(3)
    expect(statuses).toContain('CALLBACK_ERROR:polling-demo:1')
    expect(statuses).toContain('CALLBACK_ERROR:polling-demo:2')
    expect(statuses).toContain('CALLBACK_ERROR:polling-demo:3')
    expect(statuses).toContain('POLLING_DEMO_RETRY_EXHAUSTED')
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
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ events })))

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
      id: historyUuid(20),
      eventId: 'event-1',
      redeemedAt: '2026-07-24T00:00:01.000Z',
      userTwitchUsername: 'viewer',
      rewardId: null,
      card: CARD_A,
    }
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ events: [event] })))

    const callback = vi.fn()
    const cleanup = subscribeToGachaResults('streamer-1', callback, { retryDelay: 10 })
    await flushPromises()
    expect(callback).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(10)
    await flushPromises()
    expect(callback).toHaveBeenCalledTimes(1)

    cleanup()
  })

  it('retries a committed draw when the page callback fails before display', async () => {
    const event = {
      id: historyUuid(22),
      eventId: 'event-callback-retry',
      redeemedAt: '2026-07-24T00:00:01.000Z',
      userTwitchUsername: 'viewer',
      rewardId: null,
      card: CARD_A,
    }
    const statuses: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/realtime-config')) {
        return jsonResponse({
          schemaVersion: 1,
          mode: 'polling-only',
          protocolVersion: 1,
          retryPolicy: { baseDelayMs: 100, maxDelayMs: 1_000 },
          configVersion: 'callback-retry-v1',
        })
      }
      return jsonResponse({ events: [event] })
    }))

    const callback = vi.fn()
    callback.mockImplementationOnce(() => {
      throw new Error('render unavailable')
    })
    const cleanup = subscribeToGachaResults('streamer-1', callback, {
      retryDelay: 10,
      onStatusChange: (status) => statuses.push(status),
    })
    await flushPromises()

    // The first attempt fails after validation. Its event ID must be rolled
    // back rather than becoming a permanent duplicate.
    expect(callback).toHaveBeenCalledTimes(1)
    expect(statuses).toContain('CALLBACK_ERROR:polling')
    expect(statuses).toContain('POLLING_RETRY:1')

    await vi.advanceTimersByTimeAsync(10)
    await flushPromises()
    expect(callback).toHaveBeenCalledTimes(2)
    expect(callback.mock.calls[1][0]).toMatchObject({
      type: 'gacha',
      card: CARD_A,
    })

    cleanup()
  })

  it('blocks an unacknowledged head draw without advancing the cursor or reordering later rows', async () => {
    const eventA = {
      id: historyUuid(23),
      eventId: 'event-poisoned-display',
      redeemedAt: '2026-07-24T00:00:01.000Z',
      userTwitchUsername: 'viewer',
      rewardId: null,
      card: CARD_A,
    }
    const eventB = {
      id: historyUuid(24),
      eventId: 'event-after-poisoned-display',
      redeemedAt: '2026-07-24T00:00:02.000Z',
      userTwitchUsername: 'viewer',
      rewardId: null,
      card: CARD_B,
    }
    const statuses: string[] = []
    const restoredAt = '2026-07-24T00:00:00.000Z'
    let historyCalls = 0
    let recoveryMode = false
    let recoveryCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/realtime-config')) {
        return jsonResponse({
          schemaVersion: 1,
          mode: 'polling-only',
          protocolVersion: 1,
          retryPolicy: { baseDelayMs: 100, maxDelayMs: 1_000 },
          configVersion: 'callback-quarantine-v1',
        })
      }
      historyCalls += 1
      if (recoveryMode) {
        recoveryCalls += 1
        if (recoveryCalls > 1) return jsonResponse({ events: [] })
      }
      return jsonResponse({
        events: [eventA, eventB],
      })
    }))

    const callback = vi.fn()
    callback
      .mockImplementationOnce(() => false)
      .mockImplementationOnce(() => false)
      .mockImplementationOnce(() => false)
    const onHistoryCursor = vi.fn()
    const cleanup = subscribeToGachaResults('streamer-1', callback, {
      retryDelay: 10,
      onStatusChange: (status) => statuses.push(status),
      onHistoryCursor,
    })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(10)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(20)
    await flushPromises()

    expect(callback.mock.calls.map(([payload]) => payload.card.id)).toEqual([
      CARD_A.id,
      CARD_A.id,
      CARD_A.id,
    ])
    expect(statuses).toContain('CALLBACK_ERROR_BLOCKED:polling')
    expect(statuses).toContain('POLLING_BLOCKED_UNACKNOWLEDGED_EVENT')
    expect(onHistoryCursor).not.toHaveBeenCalled()
    const callsAtBlock = historyCalls
    await vi.advanceTimersByTimeAsync(60_000)
    await flushPromises()
    expect(historyCalls).toBe(callsAtBlock)

    // The unchanged cursor is the recovery handle. A fresh controller can
    // retry the same A and then display B in order without another redemption.
    recoveryMode = true
    cleanup()
    const recoveredCards: string[] = []
    const recoveredCleanup = subscribeToGachaResults('streamer-1', (payload) => {
      recoveredCards.push(payload.card.id)
    }, {
      initialHistoryCursor: { redeemedAt: restoredAt, historyId: '' },
      retryDelay: 10,
      onHistoryCursor,
    })
    await flushPromises()
    expect(recoveredCards).toEqual([CARD_A.id, CARD_B.id])
    expect(onHistoryCursor).toHaveBeenLastCalledWith({
      redeemedAt: eventB.redeemedAt,
      historyId: eventB.id,
    })
    recoveredCleanup()
  })

  it('buffers a WebSocket tail behind a polling draw whose DOM acknowledgement failed', async () => {
    class ControlledWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSING = 2
      static readonly CLOSED = 3
      static readonly instances: ControlledWebSocket[] = []
      readyState = ControlledWebSocket.CONNECTING
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      onclose: ((event: { code: number }) => void) | null = null

      constructor() {
        ControlledWebSocket.instances.push(this)
        queueMicrotask(() => {
          this.readyState = ControlledWebSocket.OPEN
          this.onopen?.()
        })
      }

      send() {}
      close(code = 1000) {
        this.readyState = ControlledWebSocket.CLOSED
        this.onclose?.({ code })
      }
      emit(message: unknown) {
        this.onmessage?.({ data: JSON.stringify(message) })
      }
    }
    vi.stubGlobal('WebSocket', ControlledWebSocket)

    const [eventA] = buildPollingRealtimeEvents(STREAMER_ID, [{
      id: historyUuid(23),
      eventId: 'event-poll-a',
      redeemedAt: '2026-07-24T00:00:01.000Z',
      userTwitchUsername: 'viewer',
      rewardId: null,
      card: CARD_A,
    }])
    const [eventB] = buildPollingRealtimeEvents(STREAMER_ID, [{
      id: historyUuid(24),
      eventId: 'event-ws-b',
      redeemedAt: '2026-07-24T00:00:02.000Z',
      userTwitchUsername: 'viewer',
      rewardId: null,
      card: CARD_B,
    }])
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
          configVersion: 'polling-ack-order-v1',
        })
      }
      historyCalls += 1
      if (historyCalls === 1) {
        return jsonResponse({ realtimeEvents: [eventA], nextCursor: null })
      }
      if (historyCalls === 2) {
        return jsonResponse({
          realtimeEvents: [eventA],
          nextCursor: { redeemedAt: eventA.occurredAt, historyId: eventA.draws[0].historyId },
        })
      }
      return jsonResponse({ realtimeEvents: [], nextCursor: null })
    }))

    const callback = vi.fn()
    let resolveFirstAttempt: ((accepted: boolean) => void) | undefined
    callback.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      resolveFirstAttempt = resolve
    }))
    const cleanup = subscribeToGachaResults('ignored', callback, { retryDelay: 10 })
    await flushPromises()
    expect(callback.mock.calls.map(([payload]) => payload.card.id)).toEqual(['card-a'])

    const socket = ControlledWebSocket.instances[0]
    socket.emit({ type: 'gacha_result', seq: 1, event: eventB })
    await flushPromises()
    // B arrived while A was still awaiting a successful polling retry.
    expect(callback.mock.calls.map(([payload]) => payload.card.id)).toEqual(['card-a'])

    resolveFirstAttempt?.(false)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(10)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1)
    await flushPromises()
    expect(callback.mock.calls.map(([payload]) => payload.card.id)).toEqual([
      'card-a',
      'card-a',
      'card-b',
    ])
    cleanup()
  })

  it('does not strand a new draw when polling sees a pending draw first in the same batch', async () => {
    class ControlledWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSING = 2
      static readonly CLOSED = 3
      static readonly instances: ControlledWebSocket[] = []
      readyState = ControlledWebSocket.CONNECTING
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      onclose: ((event: { code: number }) => void) | null = null

      constructor() {
        ControlledWebSocket.instances.push(this)
        queueMicrotask(() => {
          this.readyState = ControlledWebSocket.OPEN
          this.onopen?.()
        })
      }

      send() {}
      close(code = 1000) {
        this.readyState = ControlledWebSocket.CLOSED
        this.onclose?.({ code })
      }
      emit(message: unknown) {
        this.onmessage?.({ data: JSON.stringify(message) })
      }
    }
    vi.stubGlobal('WebSocket', ControlledWebSocket)

    const [eventA] = buildPollingRealtimeEvents(STREAMER_ID, [{
      id: historyUuid(25),
      eventId: 'event-mixed-batch',
      redeemedAt: '2026-07-24T00:00:01.000Z',
      userTwitchUsername: 'viewer',
      rewardId: null,
      card: CARD_A,
    }])
    const [eventAB] = buildPollingRealtimeEvents(STREAMER_ID, [
      {
        id: historyUuid(25),
        eventId: 'event-mixed-batch',
        redeemedAt: '2026-07-24T00:00:01.000Z',
        userTwitchUsername: 'viewer',
        rewardId: null,
        card: CARD_A,
      },
      {
        id: historyUuid(26),
        eventId: 'event-mixed-batch:2',
        redeemedAt: '2026-07-24T00:00:01.000Z',
        userTwitchUsername: 'viewer',
        rewardId: null,
        card: CARD_B,
      },
    ])
    let eventsCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/realtime-config')) {
        return jsonResponse({
          schemaVersion: 1,
          mode: 'do-primary',
          webSocketUrl: 'https://realtime.example',
          protocolVersion: 1,
          retryPolicy: { baseDelayMs: 100, maxDelayMs: 1_000 },
          configVersion: 'pending-mixed-batch-v1',
        })
      }
      eventsCalls += 1
      if (eventsCalls < 3) return jsonResponse({ realtimeEvents: [], nextCursor: null })
      if (eventsCalls < 5) {
        return jsonResponse({
          realtimeEvents: [eventAB],
          nextCursor: {
            redeemedAt: eventAB.occurredAt,
            historyId: eventAB.draws[1].historyId,
          },
        })
      }
      return jsonResponse({ realtimeEvents: [], nextCursor: null })
    }))

    const callback = vi.fn()
    let resolveFirst: ((accepted: boolean) => void) | undefined
    callback.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      resolveFirst = resolve
    }))
    const cleanup = subscribeToGachaResults('ignored', callback, { retryDelay: 2_500 })
    await flushPromises()
    for (let pass = 0; pass < 3; pass += 1) {
      await vi.advanceTimersByTimeAsync(0)
      await flushPromises()
    }
    const socket = ControlledWebSocket.instances[0]
    expect(callback).not.toHaveBeenCalled()
    socket.emit({ type: 'gacha_result', seq: 1, event: eventA })
    await flushPromises()
    expect(callback.mock.calls.map(([payload]) => payload.card.id)).toEqual([CARD_A.id])

    // Force a polling recovery while A is still waiting for its page-side ACK.
    // The response contains A followed by a new B from the same N-draw batch.
    socket.emit({ type: 'server_notice', code: 'transport_disabled' })
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    expect(callback.mock.calls.map(([payload]) => payload.card.id)).toEqual([CARD_A.id])
    const callsWhileDisplayAckIsPending = eventsCalls
    await vi.advanceTimersByTimeAsync(1_000)
    await flushPromises()
    expect(eventsCalls).toBe(callsWhileDisplayAckIsPending)

    resolveFirst?.(true)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(2_500)
    await flushPromises()
    expect(callback.mock.calls.map(([payload]) => payload.card.id)).toEqual([
      CARD_A.id,
      CARD_B.id,
    ])
    cleanup()
  })

  it('retries transient failures without switching to a second cursor owner', async () => {
    let historyAttempts = 0
    const fetchMock = vi.fn(async () => {
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
      id: historyUuid(21),
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

  it('再描画待ちのdemo callback失敗をローカル再試行し、後続フレームを先行表示しない', async () => {
    class ControlledWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly instances: ControlledWebSocket[] = []
      readyState = ControlledWebSocket.CONNECTING
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      onclose: ((event: { code: number }) => void) | null = null

      constructor() {
        ControlledWebSocket.instances.push(this)
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
      emit(message: unknown) {
        this.onmessage?.({ data: JSON.stringify(message) })
      }
    }
    vi.stubGlobal('WebSocket', ControlledWebSocket)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/realtime-config')) {
        return jsonResponse({
          schemaVersion: 1,
          mode: 'do-primary',
          webSocketUrl: 'https://realtime.example',
          protocolVersion: 1,
          retryPolicy: { baseDelayMs: 100, maxDelayMs: 1_000 },
          configVersion: 'demo-retry-v1',
        })
      }
      return jsonResponse({ realtimeEvents: [], nextCursor: null })
    }))

    const [eventA] = buildPollingRealtimeEvents(STREAMER_ID, [{
      id: 'demo:order-a',
      eventId: 'demo:order-a',
      redeemedAt: '2026-07-24T00:00:01.000Z',
      userTwitchUsername: 'DemoUser',
      card: { ...CARD_A, id: 'card-a' },
    }])
    const [eventB] = buildPollingRealtimeEvents(STREAMER_ID, [{
      id: 'demo:order-b',
      eventId: 'demo:order-b',
      redeemedAt: '2026-07-24T00:00:02.000Z',
      userTwitchUsername: 'DemoUser',
      card: { ...CARD_B, id: 'card-b' },
    }])
    const callback = vi.fn()
    callback.mockImplementationOnce(() => Promise.resolve(false))
    const cleanup = subscribeToGachaResults('ignored', callback)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()

    const socket = ControlledWebSocket.instances[0]
    socket.emit({
      type: 'welcome',
      protocolVersion: 1,
      connectionId: 'connection-demo-retry',
      serverTime: '',
      seq: 0,
    })
    socket.emit({ type: 'gacha_result', seq: 1, event: { ...eventA, deliveryKind: 'demo' } })
    socket.emit({ type: 'gacha_result', seq: 2, event: { ...eventB, deliveryKind: 'demo' } })
    expect(callback.mock.calls.map(([payload]) => payload.card.id)).toEqual(['card-a'])

    await vi.advanceTimersByTimeAsync(100)
    await flushPromises()
    expect(callback.mock.calls.map(([payload]) => payload.card.id)).toEqual([
      'card-a',
      'card-a',
      'card-b',
    ])

    // A demo that keeps failing is bounded and isolated. It must not leave a
    // later frame permanently behind `socketRecoveryActive`.
    const [eventC] = buildPollingRealtimeEvents(STREAMER_ID, [{
      id: 'demo:order-c',
      eventId: 'demo:order-c',
      redeemedAt: '2026-07-24T00:00:03.000Z',
      userTwitchUsername: 'DemoUser',
      card: { ...CARD_A, id: 'card-c' },
    }])
    const [eventD] = buildPollingRealtimeEvents(STREAMER_ID, [{
      id: 'demo:order-d',
      eventId: 'demo:order-d',
      redeemedAt: '2026-07-24T00:00:04.000Z',
      userTwitchUsername: 'DemoUser',
      card: { ...CARD_B, id: 'card-d' },
    }])
    callback
      .mockImplementationOnce(() => Promise.resolve(false))
      .mockImplementationOnce(() => Promise.resolve(false))
      .mockImplementationOnce(() => Promise.resolve(false))
      .mockImplementationOnce(() => Promise.resolve(false))
    socket.emit({ type: 'gacha_result', seq: 3, event: { ...eventC, deliveryKind: 'demo' } })
    socket.emit({ type: 'gacha_result', seq: 4, event: { ...eventD, deliveryKind: 'demo' } })
    await vi.advanceTimersByTimeAsync(1_000)
    await flushPromises()
    expect(callback.mock.calls.map(([payload]) => payload.card.id).slice(-5)).toEqual([
      'card-c',
      'card-c',
      'card-c',
      'card-c',
      'card-d',
    ])
    cleanup()
  })

  it('uses a refreshed presence capability after reconnecting', async () => {
    class ControlledWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly instances: ControlledWebSocket[] = []
      readyState = ControlledWebSocket.CONNECTING
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      onclose: ((event: { code: number }) => void) | null = null

      constructor(readonly url: string) {
        ControlledWebSocket.instances.push(this)
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
      emit(message: unknown) {
        this.onmessage?.({ data: JSON.stringify(message) })
      }
    }
    vi.stubGlobal('WebSocket', ControlledWebSocket)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/realtime-config')) {
        return jsonResponse({
          schemaVersion: 1,
          mode: 'do-primary',
          webSocketUrl: 'https://realtime.example',
          protocolVersion: 1,
          retryPolicy: { baseDelayMs: 100, maxDelayMs: 1_000 },
          configVersion: 'presence-refresh-v1',
        })
      }
      return jsonResponse({ events: [] })
    }))

    const initialToken = `${Date.now() + 24 * 60 * 60 * 1_000}.123e4567-e89b-42d3-a456-426614174000.${'a'.repeat(64)}`
    const refreshedToken = `${Date.now() + 30 * 24 * 60 * 60 * 1_000}.123e4567-e89b-42d3-a456-426614174001.${'b'.repeat(64)}`
    window.history.replaceState({}, '', `/overlay/${STREAMER_ID}?presence=${initialToken}`)
    const statuses: string[] = []
    const cleanup = subscribeToGachaResults('ignored', vi.fn(), {
      onStatusChange: (status) => statuses.push(status),
    })
    await flushPromises()

    expect(ControlledWebSocket.instances).toHaveLength(1)
    ControlledWebSocket.instances[0].emit({
      type: 'server_notice',
      code: 'presence_refresh',
      presenceToken: refreshedToken,
    })
    expect(statuses).toContain('DO_PRESENCE_REFRESHED')

    ControlledWebSocket.instances[0].close(1006)
    await vi.advanceTimersByTimeAsync(2_000)
    await flushPromises()

    expect(ControlledWebSocket.instances.length).toBeGreaterThanOrEqual(2)
    const reconnectUrl = new URL(ControlledWebSocket.instances[1].url)
    expect(reconnectUrl.searchParams.get('presence')).toBe(refreshedToken)
    cleanup()

    // Simulate OBS rebuilding the Browser Source. The configured URL still
    // contains the original token, but the refreshed capability persisted by
    // the first page lifetime must win during re-initialization.
    window.history.replaceState({}, '', `/overlay/${STREAMER_ID}?presence=${initialToken}`)
    const reloadCleanup = subscribeToGachaResults('ignored', vi.fn(), {
      retryDelay: 1000,
    })
    await flushPromises()
    expect(ControlledWebSocket.instances).toHaveLength(3)
    const reloadUrl = new URL(ControlledWebSocket.instances[2].url)
    expect(reloadUrl.searchParams.get('presence')).toBe(refreshedToken)
    reloadCleanup()

    // The settings page uses a tokenless iframe/demo URL. It must not inherit
    // the OBS capability merely because this browser has a saved token for the
    // same streamer.
    window.history.replaceState({}, '', `/overlay/${STREAMER_ID}`)
    const previewCleanup = subscribeToGachaResults('ignored', vi.fn(), {
      retryDelay: 1000,
    })
    await flushPromises()
    expect(ControlledWebSocket.instances).toHaveLength(4)
    const previewUrl = new URL(ControlledWebSocket.instances[3].url)
    expect(previewUrl.searchParams.has('presence')).toBe(false)
    previewCleanup()
  })

  it('serializes an onopen recovery behind an in-flight snapshot and runs one trailing poll', async () => {
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

    // onopen happened while the first request was unresolved. It must not
    // start concurrently, but it also must not disappear: the trailing empty
    // snapshot closes commits that landed after the first DB snapshot.
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    expect(historyCalls).toBe(2)
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
        // about the config refresh safety net; leaving sockets CONNECTING would
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
    let eventsCalls = 0
    let advertisedConfigVersion = 'test-v1'
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
      eventsCalls += 1
      return jsonResponse({
        events: [],
        realtimeConfigVersion: advertisedConfigVersion,
      })
    }))

    const [event] = buildPollingRealtimeEvents(STREAMER_ID, [{
      id: historyUuid(22),
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

    // Opening the initial socket queues one immediate DB recovery. Drain that
    // startup task before measuring the safety cadence so it cannot be mistaken
    // for an early steady-state reconciliation.
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    const eventsAfterStartup = eventsCalls
    const safetyStartedAt = Date.now()

    // Healthy overlays use one ten-minute history reconciliation as both the
    // gapless-publish recovery path and the config/build change signal. There
    // is no parallel steady-state config timer.
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await flushPromises()
    expect(configCalls).toBe(1)
    expect(eventsCalls).toBe(eventsAfterStartup)
    expect(ControlledWebSocket.instances).toHaveLength(1)

    advertisedConfigVersion = 'test-v2'
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await flushPromises()

    // At the ten-minute deadline the safety callback queues the reconciliation
    // as a separate zero-delay timer. Advance to that deadline without jumping
    // to a later liveness timer; Promise flushing alone cannot run timers.
    await vi.advanceTimersToNextTimerAsync()
    await flushPromises()
    expect(Date.now()).toBeGreaterThanOrEqual(safetyStartedAt + 10 * 60_000)
    expect(Date.now()).toBeLessThan(safetyStartedAt + 10 * 60_000 + 1_000)
    // One request detects the version change. Replacing the endpoint opens a
    // new socket, whose mandatory boundary recovery is the second request.
    expect(eventsCalls).toBe(eventsAfterStartup + 2)
    expect(configCalls).toBe(2)
    expect(ControlledWebSocket.instances).toHaveLength(2)

    ControlledWebSocket.instances[0].emit({ type: 'gacha_result', event })
    expect(callback).not.toHaveBeenCalled()
    ControlledWebSocket.instances[1].emit({ type: 'gacha_result', event })
    // The same-deadline endpoint-boundary recovery has already completed, so
    // only the current socket may deliver this frame now.
    expect(callback).toHaveBeenCalledTimes(1)

    ControlledWebSocket.instances[1].onclose?.({ code: 1006 })
    // A config endpoint change starts a fresh connection policy, so the next
    // outage uses the initial half-jitter delay (random is stubbed to zero).
    expect(statuses).toContain('DO_RECONNECT_WAIT:50')
    cleanup()
  })

  it('reconnects to a URL-only runtime change while the old socket remains healthy', async () => {
    class ControlledWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly instances: ControlledWebSocket[] = []
      readyState = ControlledWebSocket.CONNECTING
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      onclose: ((event: { code: number }) => void) | null = null

      constructor(readonly url: string) {
        ControlledWebSocket.instances.push(this)
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
      emit(message: unknown) {
        this.onmessage?.({ data: JSON.stringify(message) })
      }
    }
    vi.stubGlobal('WebSocket', ControlledWebSocket)
    vi.stubEnv('OVERLAY_REALTIME_MODE', 'do-primary')
    vi.stubEnv('OVERLAY_REALTIME_STREAMER_ALLOWLIST', STREAMER_ID)
    vi.stubEnv('OVERLAY_REALTIME_WS_URL', 'https://realtime-a.example')

    let configCalls = 0
    let eventsCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/realtime-config')) {
        configCalls += 1
        return jsonResponse(resolveOverlayRealtimeConfig(STREAMER_ID))
      }
      eventsCalls += 1
      return jsonResponse({
        realtimeEvents: [],
        nextCursor: null,
        realtimeConfigVersion: resolveOverlayRealtimeConfigVersion(STREAMER_ID),
      })
    }))

    const cleanup = subscribeToGachaResults('ignored', vi.fn())
    await flushPromises()
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()

    expect(ControlledWebSocket.instances).toHaveLength(1)
    expect(ControlledWebSocket.instances[0].url).toContain('realtime-a.example')
    const oldSocket = ControlledWebSocket.instances[0]
    oldSocket.emit({
      type: 'welcome',
      protocolVersion: 1,
      connectionId: 'connection-url-a',
      serverTime: '',
      seq: 0,
    })
    const eventsAfterStartup = eventsCalls

    // This is an environment-only endpoint rotation: mode, allowlist,
    // protocol, retry policy, and application build all remain unchanged.
    // Heartbeats prove endpoint A is healthy, so only the public-config token
    // carried by the ten-minute safety read can move the client to B.
    vi.stubEnv('OVERLAY_REALTIME_WS_URL', 'https://realtime-b.example')
    for (let halfMinute = 0; halfMinute < 19; halfMinute += 1) {
      await vi.advanceTimersByTimeAsync(30_000)
      oldSocket.emit({ type: 'server_notice', code: 'heartbeat' })
      await flushPromises()
    }
    expect(configCalls).toBe(1)
    expect(eventsCalls).toBe(eventsAfterStartup)
    expect(ControlledWebSocket.instances).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(30_000)
    oldSocket.emit({ type: 'server_notice', code: 'heartbeat' })
    await flushPromises()
    await vi.advanceTimersToNextTimerAsync()
    await flushPromises()

    expect(configCalls).toBe(2)
    expect(ControlledWebSocket.instances).toHaveLength(2)
    expect(ControlledWebSocket.instances[1].url).toContain('realtime-b.example')
    cleanup()
  })

  it('bounds URL-only rotation during a DB outage without hammering config or dropping the healthy socket', async () => {
    class ControlledWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly instances: ControlledWebSocket[] = []
      readyState = ControlledWebSocket.CONNECTING
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      onclose: ((event: { code: number }) => void) | null = null

      constructor(readonly url: string) {
        ControlledWebSocket.instances.push(this)
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
      emit(message: unknown) {
        this.onmessage?.({ data: JSON.stringify(message) })
      }
    }
    vi.stubGlobal('WebSocket', ControlledWebSocket)
    vi.stubEnv('OVERLAY_REALTIME_MODE', 'do-primary')
    vi.stubEnv('OVERLAY_REALTIME_STREAMER_ALLOWLIST', STREAMER_ID)
    vi.stubEnv('OVERLAY_REALTIME_WS_URL', 'https://realtime-a.example')

    let configCalls = 0
    let eventsCalls = 0
    let failHistory = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/realtime-config')) {
        configCalls += 1
        // The first degraded probe also fails at the edge. It must not tear
        // down a socket that is still proving liveness with heartbeats.
        if (configCalls === 2) throw new Error('temporary config edge failure')
        return jsonResponse(resolveOverlayRealtimeConfig(STREAMER_ID))
      }
      eventsCalls += 1
      if (failHistory) throw new Error('PlanetScale unavailable')
      return jsonResponse({
        realtimeEvents: [],
        nextCursor: null,
        realtimeConfigVersion: resolveOverlayRealtimeConfigVersion(STREAMER_ID),
      })
    }))

    const callback = vi.fn()
    const statuses: string[] = []
    const cleanup = subscribeToGachaResults('ignored', callback, {
      onStatusChange: (status) => statuses.push(status),
    })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()

    const oldSocket = ControlledWebSocket.instances[0]
    oldSocket.emit({
      type: 'welcome',
      protocolVersion: 1,
      connectionId: 'connection-db-outage-a',
      serverTime: '',
      seq: 0,
    })
    failHistory = true
    vi.stubEnv('OVERLAY_REALTIME_WS_URL', 'https://realtime-b.example')

    // The healthy ten-minute reconciliation fails before it can carry the new
    // config generation. That failure triggers exactly one DB-independent
    // config probe; the intentionally failed probe preserves socket A.
    for (let halfMinute = 0; halfMinute < 20; halfMinute += 1) {
      await vi.advanceTimersByTimeAsync(30_000)
      oldSocket.emit({ type: 'server_notice', code: 'heartbeat' })
      await flushPromises()
    }
    await vi.advanceTimersToNextTimerAsync()
    await flushPromises()

    expect(configCalls).toBe(2)
    expect(ControlledWebSocket.instances).toHaveLength(1)
    expect(statuses).toContain('CONFIG_REFRESH_FAILED:KEEP_CURRENT')

    // History retries continue under their existing serialized backoff, but
    // they may not turn into a config request every 30 seconds. The next probe
    // is allowed only at the five-minute degraded-mode floor.
    for (let halfMinute = 0; halfMinute < 9; halfMinute += 1) {
      await vi.advanceTimersByTimeAsync(30_000)
      oldSocket.emit({ type: 'server_notice', code: 'heartbeat' })
      await flushPromises()
    }
    expect(configCalls).toBe(2)

    await vi.advanceTimersByTimeAsync(30_000)
    oldSocket.emit({ type: 'server_notice', code: 'heartbeat' })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(30_000)
    await flushPromises()

    expect(configCalls).toBe(3)
    expect(eventsCalls).toBeGreaterThan(2)
    expect(ControlledWebSocket.instances).toHaveLength(2)
    expect(ControlledWebSocket.instances[1].url).toContain('realtime-b.example')

    const [event] = buildPollingRealtimeEvents(STREAMER_ID, [{
      id: historyUuid(23),
      eventId: 'batch-db-outage-url-switch',
      redeemedAt: '2026-07-24T00:00:01.000Z',
      userTwitchUsername: 'viewer',
      card: CARD_A,
    }])
    oldSocket.emit({ type: 'gacha_result', seq: 1, event })
    expect(callback).not.toHaveBeenCalled()
    ControlledWebSocket.instances[1].emit({
      type: 'welcome',
      protocolVersion: 1,
      connectionId: 'connection-db-outage-b',
      serverTime: '',
      seq: 0,
    })
    ControlledWebSocket.instances[1].emit({ type: 'gacha_result', seq: 1, event })
    expect(callback).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('ten-minute reconciliation recovers a gapless failed publish behind a later socket event', async () => {
    vi.setSystemTime(new Date('2026-07-24T00:00:00.000Z'))

    class ControlledWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly instances: ControlledWebSocket[] = []
      readyState = ControlledWebSocket.CONNECTING
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      onclose: ((event: { code: number }) => void) | null = null

      constructor() {
        ControlledWebSocket.instances.push(this)
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
      emit(message: unknown) {
        this.onmessage?.({ data: JSON.stringify(message) })
      }
    }
    vi.stubGlobal('WebSocket', ControlledWebSocket)

    const rows = [
      {
        id: historyUuid(40),
        eventId: 'batch-publish-failed',
        redeemedAt: '2026-07-24T00:00:01.000Z',
        userTwitchUsername: 'viewer',
        card: CARD_A,
      },
      {
        id: historyUuid(41),
        eventId: 'batch-publish-succeeded',
        redeemedAt: '2026-07-24T00:00:02.000Z',
        userTwitchUsername: 'viewer',
        card: CARD_B,
      },
    ]
    const [missedEvent, liveEvent] = rows.map((row) =>
      buildPollingRealtimeEvents(STREAMER_ID, [row])[0]
    )
    let reconciliationEnabled = false
    let reconciliationPage = 0
    let firstReconciliationSince: string | null = null
    let firstReconciliationAt: number | null = null
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.includes('/realtime-config')) {
        return jsonResponse({
          schemaVersion: 1,
          mode: 'do-primary',
          webSocketUrl: 'https://realtime.example',
          protocolVersion: 1,
          retryPolicy: { baseDelayMs: 100, maxDelayMs: 1_000 },
          configVersion: 'do-primary-v1',
          overlayVersion: 'build-current',
        })
      }
      if (!reconciliationEnabled) {
        return jsonResponse({ realtimeEvents: [], nextCursor: null })
      }

      reconciliationPage += 1
      if (reconciliationPage === 1) {
        firstReconciliationSince = url.searchParams.get('since')
        firstReconciliationAt = Date.now()
        return jsonResponse({
          realtimeEvents: [missedEvent, liveEvent],
          nextCursor: {
            redeemedAt: rows[1].redeemedAt,
            historyId: rows[1].id,
          },
        })
      }
      return jsonResponse({ realtimeEvents: [], nextCursor: null })
    }))

    const callback = vi.fn()
    const onHistoryCursor = vi.fn()
    const cleanup = subscribeToGachaResults('ignored', callback, {
      onHistoryCursor,
    })
    await flushPromises()
    for (let pass = 0; pass < 3; pass += 1) {
      await vi.advanceTimersByTimeAsync(0)
      await flushPromises()
    }

    const socket = ControlledWebSocket.instances[0]
    socket.emit({
      type: 'welcome',
      protocolVersion: 1,
      connectionId: 'connection-publisher-recovery',
      serverTime: '',
      seq: 0,
    })
    socket.emit({ type: 'gacha_result', seq: 1, event: liveEvent })
    expect(callback.mock.calls.map(([payload]) => payload.card.id)).toEqual([
      CARD_B.id,
    ])
    // Socket delivery is not a durable DB checkpoint: an earlier publish may
    // have failed before the room could assign a sequence number.
    expect(onHistoryCursor).not.toHaveBeenCalled()

    reconciliationEnabled = true
    for (let halfMinute = 0; halfMinute < 19; halfMinute += 1) {
      await vi.advanceTimersByTimeAsync(30_000)
      socket.emit({ type: 'server_notice', code: 'heartbeat' })
      await flushPromises()
    }

    // A healthy socket must not touch history before the ten-minute safety
    // deadline, even though liveness is being renewed every thirty seconds.
    expect(firstReconciliationSince).toBeNull()
    expect(reconciliationPage).toBe(0)

    await vi.advanceTimersByTimeAsync(30_000)
    socket.emit({ type: 'server_notice', code: 'heartbeat' })
    await flushPromises()

    // The deadline callback schedules the DB cycle at the next timer deadline.
    // This avoids jumping to a later liveness deadline while still allowing the
    // data page and its mandatory terminating empty page to drain together.
    await vi.advanceTimersToNextTimerAsync()
    await flushPromises()

    expect(firstReconciliationSince).toBe('2026-07-24T00:00:00.000Z')
    expect(firstReconciliationAt).toBeGreaterThanOrEqual(
      new Date('2026-07-24T00:10:00.000Z').getTime()
    )
    expect(firstReconciliationAt).toBeLessThan(
      new Date('2026-07-24T00:10:01.000Z').getTime()
    )
    expect(reconciliationPage).toBe(2)
    expect(callback.mock.calls.map(([payload]) => payload.card.id)).toEqual([
      CARD_B.id,
      CARD_A.id,
    ])
    expect(onHistoryCursor).toHaveBeenLastCalledWith({
      redeemedAt: rows[1].redeemedAt,
      historyId: rows[1].id,
    })
    cleanup()
  })

  it('reconciles and reload-dedupes 513 socket draws without an eviction cascade', async () => {
    vi.setSystemTime(new Date('2026-07-24T00:00:00.000Z'))

    class ControlledWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly instances: ControlledWebSocket[] = []
      readyState = ControlledWebSocket.CONNECTING
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      onclose: ((event: { code: number }) => void) | null = null

      constructor() {
        ControlledWebSocket.instances.push(this)
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
      emit(message: unknown) {
        this.onmessage?.({ data: JSON.stringify(message) })
      }
    }
    vi.stubGlobal('WebSocket', ControlledWebSocket)

    const rows = Array.from({ length: 513 }, (_, index) => ({
      id: historyUuid(1_000 + index),
      eventId: `batch-volume-${index}`,
      redeemedAt: new Date(
        new Date('2026-07-24T00:00:01.000Z').getTime() + index * 1_000
      ).toISOString(),
      userTwitchUsername: 'viewer',
      card: { ...CARD_A, id: `card-volume-${index}` },
    }))
    const realtimeEvents = rows.map((row) =>
      buildPollingRealtimeEvents(STREAMER_ID, [row])[0]
    )
    let historyReady = false
    let pageIndex = 0
    const historyPageSizes: number[] = []
    let reloaded = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/realtime-config')) {
        return jsonResponse({
          schemaVersion: 1,
          mode: reloaded ? 'polling-only' : 'do-primary',
          ...(reloaded ? {} : { webSocketUrl: 'https://realtime.example' }),
          protocolVersion: 1,
          retryPolicy: { baseDelayMs: 100, maxDelayMs: 1_000 },
          configVersion: reloaded ? 'polling-v1' : 'do-primary-v1',
        })
      }
      if (!historyReady) {
        return jsonResponse({ realtimeEvents: [], nextCursor: null })
      }
      const pageEvents = realtimeEvents.slice(pageIndex * 100, (pageIndex + 1) * 100)
      pageIndex += 1
      historyPageSizes.push(pageEvents.length)
      const last = pageEvents.at(-1)
      return jsonResponse({
        realtimeEvents: pageEvents,
        nextCursor: last
          ? {
              redeemedAt: last.occurredAt,
              historyId: last.draws.at(-1)?.historyId,
            }
          : null,
      })
    }))

    const statuses: string[] = []
    const callback = vi.fn()
    const cleanup = subscribeToGachaResults('ignored', callback, {
      onStatusChange: (status) => statuses.push(status),
    })
    await flushPromises()
    for (let pass = 0; pass < 3; pass += 1) {
      await vi.advanceTimersByTimeAsync(0)
      await flushPromises()
    }

    const socket = ControlledWebSocket.instances[0]
    socket.emit({
      type: 'welcome',
      protocolVersion: 1,
      connectionId: 'connection-volume',
      serverTime: '',
      seq: 0,
    })
    historyReady = true
    realtimeEvents.forEach((event, index) => {
      socket.emit({ type: 'gacha_result', seq: index + 1, event })
    })
    expect(callback).toHaveBeenCalledTimes(513)
    expect(statuses).toContain('DO_RECONCILE_VOLUME:512')

    const expectedHistoryPageSizes = [100, 100, 100, 100, 100, 13, 0]
    // Same-deadline pages may coalesce within one async timer advance. Stop on
    // the observed seventh response, rather than advancing seven timers and
    // crossing into the later liveness or steady-state polling deadlines.
    const driveExpectedHistoryDrain = async () => {
      for (
        let advanceCount = 0;
        advanceCount < expectedHistoryPageSizes.length
          && historyPageSizes.length < expectedHistoryPageSizes.length;
        advanceCount += 1
      ) {
        await vi.advanceTimersToNextTimerAsync()
        await flushPromises()
      }
      expect(historyPageSizes).toEqual(expectedHistoryPageSizes)
      expect(pageIndex).toBe(expectedHistoryPageSizes.length)
    }
    await driveExpectedHistoryDrain()
    expect(callback).toHaveBeenCalledTimes(513)
    cleanup()

    // A version reload can happen before or after reconciliation. The bounded
    // session cache must retain the whole >512 live window so restarting from
    // the older DB checkpoint does not replay any draw.
    reloaded = true
    pageIndex = 0
    historyPageSizes.length = 0
    const reloadCallback = vi.fn()
    const reloadCleanup = subscribeToGachaResults('ignored', reloadCallback, {
      initialHistoryCursor: {
        redeemedAt: '2026-07-24T00:00:00.000Z',
        historyId: '',
      },
    })
    await flushPromises()
    await driveExpectedHistoryDrain()
    expect(reloadCallback).not.toHaveBeenCalled()
    reloadCleanup()
  })

  it('bounds recovery buffering and keeps DB recovery duplicate-free after degradation', async () => {
    class ControlledWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly instances: ControlledWebSocket[] = []
      readyState = ControlledWebSocket.CONNECTING
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      onclose: ((event: { code: number }) => void) | null = null

      constructor() {
        ControlledWebSocket.instances.push(this)
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
      emit(message: unknown) {
        this.onmessage?.({ data: JSON.stringify(message) })
      }
    }
    vi.stubGlobal('WebSocket', ControlledWebSocket)

    const rows = Array.from({ length: 34 }, (_, index) => ({
      id: historyUuid(2_000 + index),
      eventId: `batch-buffer-${index}`,
      redeemedAt: `2026-07-24T00:00:${String(index + 1).padStart(2, '0')}.000Z`,
      userTwitchUsername: 'viewer',
      card: { ...CARD_A, id: `card-buffer-${index}` },
    }))
    const realtimeEvents = rows.map((row) =>
      buildPollingRealtimeEvents(STREAMER_ID, [row])[0]
    )
    let recoveryPromise: Promise<Response> | null = null
    let afterRecovery = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/realtime-config')) {
        return jsonResponse({
          schemaVersion: 1,
          mode: 'do-primary',
          webSocketUrl: 'https://realtime.example',
          protocolVersion: 1,
          retryPolicy: { baseDelayMs: 100, maxDelayMs: 1_000 },
          configVersion: 'do-primary-v1',
        })
      }
      if (recoveryPromise) {
        const pending = recoveryPromise
        recoveryPromise = null
        return pending
      }
      return jsonResponse({
        realtimeEvents: [],
        nextCursor: null,
        ...(afterRecovery ? { realtimeConfigVersion: 'do-primary-v1' } : {}),
      })
    }))

    const callback = vi.fn()
    const statuses: string[] = []
    const cleanup = subscribeToGachaResults('ignored', callback, {
      onStatusChange: (status) => statuses.push(status),
    })
    await flushPromises()
    for (let pass = 0; pass < 3; pass += 1) {
      await vi.advanceTimersByTimeAsync(0)
      await flushPromises()
    }

    let resolveRecovery!: (response: Response) => void
    recoveryPromise = new Promise<Response>((resolve) => {
      resolveRecovery = resolve
    })
    const socket = ControlledWebSocket.instances[0]
    socket.emit({
      type: 'welcome',
      protocolVersion: 1,
      connectionId: 'connection-buffer',
      serverTime: '',
      seq: 0,
    })
    socket.emit({ type: 'gacha_result', seq: 2, event: realtimeEvents[0] })
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()

    for (let index = 1; index < 33; index += 1) {
      socket.emit({
        type: 'gacha_result',
        seq: index + 2,
        event: realtimeEvents[index],
      })
    }
    expect(statuses).toContain('DO_RECOVERY_DEGRADED:capacity')
    expect(callback).toHaveBeenCalledTimes(33)

    afterRecovery = true
    resolveRecovery(jsonResponse({
      realtimeEvents: realtimeEvents.slice(0, 33),
      nextCursor: {
        redeemedAt: rows[32].redeemedAt,
        historyId: rows[32].id,
      },
    }))
    await flushPromises()
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    expect(callback).toHaveBeenCalledTimes(33)

    // A later low-volume recovery proves the independent time bound: one live
    // frame cannot remain hidden forever merely because its DB read is stuck.
    recoveryPromise = new Promise<Response>(() => {})
    // Leave seq 35 missing so this frame starts recovery buffering; a contiguous
    // seq 35 would be delivered immediately and would not exercise the timeout.
    socket.emit({ type: 'gacha_result', seq: 36, event: realtimeEvents[33] })
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    expect(callback).toHaveBeenCalledTimes(33)
    expect(statuses).not.toContain('DO_RECOVERY_DEGRADED:timeout')
    await vi.advanceTimersByTimeAsync(9_999)
    expect(callback).toHaveBeenCalledTimes(33)
    expect(statuses).not.toContain('DO_RECOVERY_DEGRADED:timeout')
    await vi.advanceTimersByTimeAsync(1)
    await flushPromises()
    expect(statuses).toContain('DO_RECOVERY_DEGRADED:timeout')
    expect(callback).toHaveBeenCalledTimes(34)
    cleanup()
  })

  it('validates socket frames before the bounded DOM-ack queue and signals queue saturation', async () => {
    class ControlledWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSED = 3
      static readonly instances: ControlledWebSocket[] = []
      readyState = ControlledWebSocket.CONNECTING
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      onclose: ((event: { code: number }) => void) | null = null

      constructor() {
        ControlledWebSocket.instances.push(this)
        queueMicrotask(() => {
          this.readyState = ControlledWebSocket.OPEN
          this.onopen?.()
        })
      }

      send() {}
      close(code = 1000) {
        this.readyState = ControlledWebSocket.CLOSED
        this.onclose?.({ code })
      }
      emit(message: unknown) {
        this.onmessage?.({ data: JSON.stringify(message) })
      }
    }
    vi.stubGlobal('WebSocket', ControlledWebSocket)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/realtime-config')) {
        return jsonResponse({
          schemaVersion: 1,
          mode: 'do-primary',
          webSocketUrl: 'https://realtime.example',
          protocolVersion: 1,
          retryPolicy: { baseDelayMs: 100, maxDelayMs: 1_000 },
          configVersion: 'do-primary-v1',
        })
      }
      return jsonResponse({ realtimeEvents: [], nextCursor: null })
    }))

    const rows = Array.from({ length: 34 }, (_, index) => ({
      id: historyUuid(3_000 + index),
      eventId: `dom-ack-queue-${index}`,
      redeemedAt: `2026-07-24T01:00:${String(index).padStart(2, '0')}.000Z`,
      userTwitchUsername: 'viewer',
      card: { ...CARD_A, id: `dom-ack-card-${index}` },
    }))
    const events = rows.map((row) => buildPollingRealtimeEvents(STREAMER_ID, [row])[0])
    let resolveFirst!: (accepted: boolean) => void
    const firstAck = new Promise<boolean>((resolve) => {
      resolveFirst = resolve
    })
    const callback = vi.fn((payload: GachaBroadcastPayload) => {
      void payload
      return callback.mock.calls.length === 1 ? firstAck : true
    })
    const statuses: string[] = []
    const cleanup = subscribeToGachaResults('ignored', callback, {
      onStatusChange: (status) => statuses.push(status),
    })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()

    const socket = ControlledWebSocket.instances[0]
    socket.emit({
      type: 'welcome',
      protocolVersion: 1,
      connectionId: 'dom-ack-queue-connection',
      serverTime: '',
      seq: 0,
    })
    socket.emit({ type: 'gacha_result', seq: 1, event: events[0] })
    await flushPromises()
    expect(callback).toHaveBeenCalledTimes(1)

    // This malformed frame is rejected before it can consume one of the
    // pending delivery slots while the first DOM ACK is still unresolved.
    socket.emit({
      type: 'gacha_result',
      seq: 2,
      event: { ...events[1], draws: [] },
    })
    expect(statuses).toContain('INVALID_EVENT:durable-object')
    expect(callback).toHaveBeenCalledTimes(1)

    // The active task is held by firstAck; only 32 additional validated task
    // wrappers are retained. The 33rd is dropped in favor of authoritative
    // recovery and reports saturation instead of growing without a bound.
    socket.emit({ type: 'gacha_result', seq: 3, event: events[1] })
    for (let index = 2; index < events.length; index += 1) {
      socket.emit({ type: 'gacha_result', seq: index + 1, event: events[index] })
    }
    expect(statuses).toContain('DO_DELIVERY_QUEUE_FULL')
    expect(callback).toHaveBeenCalledTimes(1)

    resolveFirst(true)
    await flushPromises()
    cleanup()
  })

  it('probes legacy events once when a modern connected client reaches a rolled-back config route', async () => {
    class ControlledWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly instances: ControlledWebSocket[] = []
      readyState = ControlledWebSocket.CONNECTING
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      onclose: ((event: { code: number }) => void) | null = null

      constructor() {
        ControlledWebSocket.instances.push(this)
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
      emit(message: unknown) {
        this.onmessage?.({ data: JSON.stringify(message) })
      }
    }
    vi.stubGlobal('WebSocket', ControlledWebSocket)

    let configCalls = 0
    let eventsCalls = 0
    let rolledBack = false
    const rolledBackEventCallTimes: number[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/realtime-config')) {
        configCalls += 1
        return jsonResponse({
          schemaVersion: 1,
          mode: 'do-primary',
          webSocketUrl: 'https://realtime.example',
          protocolVersion: 1,
          retryPolicy: { baseDelayMs: 100, maxDelayMs: 1_000 },
          configVersion: 'do-primary-v1',
          ...(configCalls === 1 ? { overlayVersion: 'build-modern' } : {}),
        })
      }
      eventsCalls += 1
      if (rolledBack) rolledBackEventCallTimes.push(Date.now())
      return jsonResponse({
        realtimeEvents: [],
        nextCursor: null,
        overlayVersion: rolledBack ? 'build-rolled-back' : 'build-modern',
        realtimeConfigVersion: rolledBack ? 'do-primary-v2' : 'do-primary-v1',
      })
    }))

    const onOverlayVersion = vi.fn()
    const cleanup = subscribeToGachaResults('ignored', vi.fn(), {
      onOverlayVersion,
    })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    const eventsAfterStartup = eventsCalls
    const safetyStartedAt = Date.now()
    onOverlayVersion.mockClear()
    rolledBack = true

    const socket = ControlledWebSocket.instances[0]
    for (let halfMinute = 0; halfMinute < 19; halfMinute += 1) {
      // Keep each heartbeat inside the 150-second liveness deadline so this
      // remains a healthy connected rollback, not disconnect recovery.
      await vi.advanceTimersByTimeAsync(30_000)
      socket.emit({ type: 'server_notice', code: 'heartbeat' })
      await flushPromises()
    }

    // The modern client must not reconcile or refetch config before ten minutes.
    expect(configCalls).toBe(1)
    expect(eventsCalls).toBe(eventsAfterStartup)

    await vi.advanceTimersByTimeAsync(30_000)
    socket.emit({ type: 'server_notice', code: 'heartbeat' })
    await flushPromises()

    // Run the history cycle queued by the ten-minute safety callback. Its
    // version mismatch refetches config; the present-to-absent overlayVersion
    // transition then queues exactly one same-deadline legacy history probe.
    await vi.advanceTimersToNextTimerAsync()
    await flushPromises()

    expect(ControlledWebSocket.instances).toHaveLength(1)
    expect(configCalls).toBe(2)
    expect(eventsCalls).toBe(eventsAfterStartup + 2)
    expect(rolledBackEventCallTimes).toHaveLength(2)
    expect(rolledBackEventCallTimes[0]).toBeGreaterThanOrEqual(
      safetyStartedAt + 10 * 60_000
    )
    expect(rolledBackEventCallTimes[0]).toBeLessThan(
      safetyStartedAt + 10 * 60_000 + 1_000
    )
    expect(onOverlayVersion).toHaveBeenCalledTimes(2)
    expect(onOverlayVersion).toHaveBeenNthCalledWith(1, 'build-rolled-back')
    expect(onOverlayVersion).toHaveBeenNthCalledWith(2, 'build-rolled-back')
    cleanup()
  })

  it('applies a rollout change reported by history polling without a config timer', async () => {
    // The overlay used to poll /realtime-config every 30 seconds purely to
    // notice a rollout/rollback, which was roughly half of all overlay
    // requests. The events endpoint now echoes the effective config version on
    // a pass the overlay already makes, so this is the path that must keep the
    // kill switch working.
    class ControlledWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly instances: ControlledWebSocket[] = []
      readyState = ControlledWebSocket.CONNECTING
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      onclose: ((event: { code: number }) => void) | null = null

      constructor(readonly url: string) {
        ControlledWebSocket.instances.push(this)
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
    }
    vi.stubGlobal('WebSocket', ControlledWebSocket)

    // A streamer that has not been rolled out yet still polls history as its
    // primary transport, so that is the pass which carries the enable signal.
    // (The disable direction is covered by the room's server_notice below,
    // because a connected overlay no longer polls on a timer at all.)
    let serverVersion = 'polling-only-v1'
    let configCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/realtime-config')) {
        configCalls += 1
        const enabled = serverVersion !== 'polling-only-v1'
        return jsonResponse({
          schemaVersion: 1,
          mode: enabled ? 'do-primary' : 'polling-only',
          ...(enabled ? { webSocketUrl: 'https://realtime-b.example' } : {}),
          protocolVersion: 1,
          retryPolicy: { baseDelayMs: 100, maxDelayMs: 1_000 },
          configVersion: serverVersion,
        })
      }
      return jsonResponse({ events: [], realtimeConfigVersion: serverVersion })
    }))

    const cleanup = subscribeToGachaResults('ignored', vi.fn(), {
      retryDelay: 3_000,
    })
    await flushPromises()
    expect(ControlledWebSocket.instances).toHaveLength(0)
    expect(configCalls).toBe(1)

    // Operator enables this streamer. No config poll is scheduled for another
    // ten minutes, so only the history pass can carry this promptly.
    serverVersion = 'do-primary-v1'

    await vi.advanceTimersByTimeAsync(30_000)
    await flushPromises()

    expect(configCalls).toBe(2)
    expect(ControlledWebSocket.instances).toHaveLength(1)
    expect(ControlledWebSocket.instances[0].url).toContain('realtime-b.example')
    cleanup()
  })

  it('stops polling history while the socket is healthy and resumes on a gap', async () => {
    // The point of the sequence number: a connected overlay makes no periodic
    // HTTP request, and reloads history only when it can prove it missed a
    // delivery.
    class ControlledWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly instances: ControlledWebSocket[] = []
      readyState = ControlledWebSocket.CONNECTING
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      onclose: ((event: { code: number }) => void) | null = null

      constructor(readonly url: string) {
        ControlledWebSocket.instances.push(this)
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
          configVersion: 'do-primary-v1',
        })
      }
      historyCalls += 1
      return jsonResponse({ events: [], realtimeConfigVersion: 'do-primary-v1' })
    }))

    const [event] = buildPollingRealtimeEvents(STREAMER_ID, [{
      id: historyUuid(30),
      eventId: 'batch-seq-1',
      redeemedAt: '2026-07-24T00:00:02.000Z',
      userTwitchUsername: 'viewer',
      card: CARD_A,
    }])
    const statuses: string[] = []
    const cleanup = subscribeToGachaResults('ignored', vi.fn(), {
      retryDelay: 3_000,
      onStatusChange: (status) => statuses.push(status),
    })
    await flushPromises()
    const socket = ControlledWebSocket.instances[0]
    socket.emit({ type: 'welcome', protocolVersion: 1, connectionId: 'c1', serverTime: '', seq: 7 })
    // Connecting deliberately reloads history once (onopen closes the gap left
    // by the previous socket). Settle that before measuring the steady state.
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    const afterConnect = historyCalls

    // Ten minutes of a room that is alive but has nothing to deliver. The
    // heartbeat is what the real room emits on its kill-switch wake; without
    // it the liveness deadline would (correctly) tear the socket down.
    for (let minute = 0; minute < 10; minute += 1) {
      await vi.advanceTimersByTimeAsync(60_000)
      socket.emit({ type: 'server_notice', code: 'heartbeat' })
      await flushPromises()
    }
    expect(historyCalls).toBe(afterConnect)

    // seq 7 -> 9 skips one delivery, which is the only thing that should make a
    // connected overlay reload history.
    socket.emit({ type: 'gacha_result', seq: 9, event })
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    expect(historyCalls).toBeGreaterThan(afterConnect)
    expect(statuses).toContain('DO_SEQ_GAP:7->9')
    cleanup()
  })

  it('delivers signed demo frames immediately without manufacturing DB reconciliation debt', async () => {
    class ControlledWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly instances: ControlledWebSocket[] = []
      readyState = ControlledWebSocket.CONNECTING
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      onclose: ((event: { code: number }) => void) | null = null

      constructor() {
        ControlledWebSocket.instances.push(this)
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
      emit(message: unknown) {
        this.onmessage?.({ data: JSON.stringify(message) })
      }
    }
    vi.stubGlobal('WebSocket', ControlledWebSocket)

    let historyCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/realtime-config')) {
        return jsonResponse({
          schemaVersion: 1,
          mode: 'do-primary',
          webSocketUrl: 'https://realtime.example',
          protocolVersion: 1,
          retryPolicy: { baseDelayMs: 100, maxDelayMs: 1_000 },
          configVersion: 'do-primary-v1',
        })
      }
      historyCalls += 1
      return jsonResponse({
        realtimeEvents: [],
        nextCursor: null,
        realtimeConfigVersion: 'do-primary-v1',
      })
    }))

    const callback = vi.fn()
    const statuses: string[] = []
    const cleanup = subscribeToGachaResults('ignored', callback, {
      onStatusChange: (status) => statuses.push(status),
    })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()

    const historyAfterStartup = historyCalls
    const socket = ControlledWebSocket.instances[0]
    socket.emit({
      type: 'welcome',
      protocolVersion: 1,
      connectionId: 'connection-demo',
      serverTime: '',
      seq: 0,
    })

    // Exercise the exact 512-event threshold that committed socket traffic
    // uses to request an early DB reconciliation. Demos have only a bounded KV
    // fallback and no gacha_history row, so even sustained operator previews
    // must display synchronously without crossing that committed-data guard.
    for (let index = 1; index <= 512; index += 1) {
      const [baseEvent] = buildPollingRealtimeEvents(STREAMER_ID, [{
        id: `demo:history-${index}`,
        eventId: `demo:event-${index}`,
        redeemedAt: `2026-07-24T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
        userTwitchUsername: 'DemoUser',
        card: { ...CARD_A, id: `demo-card-${index}` },
      }])
      socket.emit({
        type: 'gacha_result',
        seq: index,
        event: { ...baseEvent, deliveryKind: 'demo' },
      })
    }
    await flushPromises()

    expect(callback).toHaveBeenCalledTimes(512)
    expect(callback.mock.calls[0][0].userTwitchUsername).toBe('DemoUser')
    expect(historyCalls).toBe(historyAfterStartup)
    expect(statuses.some((status) => status.startsWith('DO_RECONCILE_VOLUME:'))).toBe(false)
    cleanup()
  })

  it.each([
    ['recovers a missed immediate publish from KV at ten minutes', false],
    ['deduplicates an immediate DO demo against its later KV fallback', true],
  ])('%s', async (_label, deliverImmediately) => {
    vi.setSystemTime(new Date('2026-07-24T00:00:00.000Z'))

    class ControlledWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly instances: ControlledWebSocket[] = []
      readyState = ControlledWebSocket.CONNECTING
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      onclose: ((event: { code: number }) => void) | null = null

      constructor() {
        ControlledWebSocket.instances.push(this)
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
      emit(message: unknown) {
        this.onmessage?.({ data: JSON.stringify(message) })
      }
    }
    vi.stubGlobal('WebSocket', ControlledWebSocket)

    const demoEvent = {
      id: 'demo:history-fallback',
      eventId: 'demo:event-fallback',
      redeemedAt: '2026-07-24T00:00:01.000Z',
      userTwitchUsername: 'DemoUser',
      rewardId: null,
      card: CARD_A,
    }
    const [socketEnvelope] = buildPollingRealtimeEvents(STREAMER_ID, [{
      id: demoEvent.id,
      eventId: demoEvent.eventId,
      redeemedAt: demoEvent.redeemedAt,
      userTwitchUsername: demoEvent.userTwitchUsername,
      rewardId: null,
      card: CARD_A,
    }])
    const pollingUrls: URL[] = []
    let fallbackAvailable = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.includes('/realtime-config')) {
        return jsonResponse({
          schemaVersion: 1,
          mode: 'do-primary',
          webSocketUrl: 'https://realtime.example',
          protocolVersion: 1,
          retryPolicy: { baseDelayMs: 100, maxDelayMs: 1_000 },
          configVersion: 'do-primary-v1',
        })
      }
      pollingUrls.push(url)
      return jsonResponse({
        realtimeEvents: [],
        nextCursor: null,
        demoEvent: fallbackAvailable ? demoEvent : null,
        realtimeConfigVersion: 'do-primary-v1',
      })
    }))

    const callback = vi.fn()
    const cleanup = subscribeToGachaResults('ignored', callback)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()

    const socket = ControlledWebSocket.instances[0]
    socket.emit({
      type: 'welcome',
      protocolVersion: 1,
      connectionId: 'connection-demo-fallback',
      serverTime: '',
      seq: 0,
    })
    if (deliverImmediately) {
      socket.emit({
        type: 'gacha_result',
        seq: 1,
        event: { ...socketEnvelope, deliveryKind: 'demo' },
      })
      expect(callback).toHaveBeenCalledTimes(1)
    }
    fallbackAvailable = true

    // The normal healthy-socket sweep is the longest client recovery path.
    // The KV store keeps the same immutable event beyond this deadline; if DO
    // fanout failed it appears here, and if DO succeeded the shared eventId
    // makes this response a duplicate instead of a second overlay display.
    for (let halfMinute = 0; halfMinute < 20; halfMinute += 1) {
      await vi.advanceTimersByTimeAsync(30_000)
      socket.emit({ type: 'server_notice', code: 'heartbeat' })
      await flushPromises()
    }
    await vi.advanceTimersToNextTimerAsync()
    await flushPromises()

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback.mock.calls[0][0].userTwitchUsername).toBe('DemoUser')
    // Force one more recovery pass after the fallback row has been consumed;
    // the next request must carry the independent demo cursor rather than
    // reading the same KV row until its TTL expires.
    socket.close(1006)
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    expect(pollingUrls.some((url) => (
      url.searchParams.get('demoSince') === demoEvent.redeemedAt
    ))).toBe(true)
    cleanup()
  })

  it('buffers the gap frame until DB recovery displays seq 8 then seq 9 exactly once', async () => {
    class ControlledWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly instances: ControlledWebSocket[] = []
      readyState = ControlledWebSocket.CONNECTING
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      onclose: ((event: { code: number }) => void) | null = null

      constructor() {
        ControlledWebSocket.instances.push(this)
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
      emit(message: unknown) {
        this.onmessage?.({ data: JSON.stringify(message) })
      }
    }
    vi.stubGlobal('WebSocket', ControlledWebSocket)

    const rows = [
      {
        id: historyUuid(38),
        eventId: 'batch-seq-8',
        redeemedAt: '2026-07-24T00:00:08.000Z',
        userTwitchUsername: 'viewer',
        card: CARD_A,
      },
      {
        id: historyUuid(39),
        eventId: 'batch-seq-9',
        redeemedAt: '2026-07-24T00:00:09.000Z',
        userTwitchUsername: 'viewer',
        card: CARD_B,
      },
    ]
    const [event8, event9] = rows.map((row) =>
      buildPollingRealtimeEvents(STREAMER_ID, [row])[0]
    )
    let gapRecovery = false
    let gapPage = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/realtime-config')) {
        return jsonResponse({
          schemaVersion: 1,
          mode: 'do-primary',
          webSocketUrl: 'https://realtime.example',
          protocolVersion: 1,
          retryPolicy: { baseDelayMs: 100, maxDelayMs: 1_000 },
          configVersion: 'do-primary-v1',
          overlayVersion: 'build-current',
        })
      }
      if (!gapRecovery) return jsonResponse({ realtimeEvents: [], nextCursor: null })
      gapPage += 1
      if (gapPage === 1) {
        return jsonResponse({
          realtimeEvents: [event8, event9],
          nextCursor: {
            redeemedAt: rows[1].redeemedAt,
            historyId: rows[1].id,
          },
        })
      }
      return jsonResponse({ realtimeEvents: [], nextCursor: null })
    }))

    const callback = vi.fn()
    const cleanup = subscribeToGachaResults('ignored', callback)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()

    const socket = ControlledWebSocket.instances[0]
    socket.emit({
      type: 'welcome',
      protocolVersion: 1,
      connectionId: 'connection-gap',
      serverTime: '',
      seq: 7,
    })
    gapRecovery = true
    socket.emit({ type: 'gacha_result', seq: 9, event: event9 })
    expect(callback).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()

    expect(callback.mock.calls.map(([payload]) => payload.card.id)).toEqual([
      CARD_A.id,
      CARD_B.id,
    ])
    cleanup()
  })

  it('drains a reconnect backlog larger than the 100-row API page in DB order', async () => {
    class ControlledWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly instances: ControlledWebSocket[] = []
      readyState = ControlledWebSocket.CONNECTING
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      onclose: ((event: { code: number }) => void) | null = null

      constructor() {
        ControlledWebSocket.instances.push(this)
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
    }
    vi.stubGlobal('WebSocket', ControlledWebSocket)

    const rows = Array.from({ length: 205 }, (_, index) => ({
      id: historyUuid(100 + index),
      eventId: `batch-backlog-${String(index).padStart(3, '0')}`,
      redeemedAt: `2026-07-24T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
      userTwitchUsername: 'viewer',
      card: { ...CARD_A, id: `card-backlog-${index}` },
    }))
    let recovering = false
    let pageIndex = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/realtime-config')) {
        return jsonResponse({
          schemaVersion: 1,
          mode: 'do-primary',
          webSocketUrl: 'https://realtime.example',
          protocolVersion: 1,
          retryPolicy: { baseDelayMs: 100, maxDelayMs: 1_000 },
          configVersion: 'do-primary-v1',
          overlayVersion: 'build-current',
        })
      }
      if (!recovering) return jsonResponse({ realtimeEvents: [], nextCursor: null })

      const pageRows = rows.slice(pageIndex * 100, (pageIndex + 1) * 100)
      pageIndex += 1
      const last = pageRows.at(-1)
      return jsonResponse({
        realtimeEvents: buildPollingRealtimeEvents(STREAMER_ID, pageRows),
        nextCursor: last
          ? { redeemedAt: last.redeemedAt, historyId: last.id }
          : null,
      })
    }))

    const callback = vi.fn()
    const cleanup = subscribeToGachaResults('ignored', callback)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()

    recovering = true
    ControlledWebSocket.instances[0].close(1006)
    for (let pass = 0; pass < 4 && pageIndex < 4; pass += 1) {
      // Each non-empty response queues the next page as a new timer task. Four
      // responses cover 100 + 100 + 5 rows and the mandatory terminating empty
      // page. Stop there instead of advancing into the later reconnect timer,
      // whose onopen correctly starts a separate recovery snapshot.
      await vi.advanceTimersToNextTimerAsync()
      await flushPromises()
    }

    expect(pageIndex).toBe(4)
    expect(callback).toHaveBeenCalledTimes(205)
    expect(callback.mock.calls.map(([payload]) => payload.card.id)).toEqual(
      rows.map((row) => row.card.id)
    )
    cleanup()
  })

  it('does not reconnect into a room that reported itself disabled', async () => {
    // Found in preview during the kill-switch test: the two allowlists (app
    // Worker and standalone Worker) are separate secrets, so mid-rollout the
    // room can refuse a streamer while the config endpoint still says
    // `do-primary`. Reconnecting there just loops against 503 responses.
    class ControlledWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly instances: ControlledWebSocket[] = []
      readyState = ControlledWebSocket.CONNECTING
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      onclose: ((event: { code: number }) => void) | null = null

      constructor(readonly url: string) {
        ControlledWebSocket.instances.push(this)
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

    // The app Worker keeps advertising do-primary throughout.
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/realtime-config')) {
        return jsonResponse({
          schemaVersion: 1,
          mode: 'do-primary',
          webSocketUrl: 'https://realtime.example',
          protocolVersion: 1,
          retryPolicy: { baseDelayMs: 100, maxDelayMs: 1_000 },
          configVersion: 'do-primary-v1',
        })
      }
      return jsonResponse({ events: [], realtimeConfigVersion: 'do-primary-v1' })
    }))

    const statuses: string[] = []
    const cleanup = subscribeToGachaResults('ignored', vi.fn(), {
      retryDelay: 3_000,
      onStatusChange: (status) => statuses.push(status),
    })
    await flushPromises()
    expect(ControlledWebSocket.instances).toHaveLength(1)

    ControlledWebSocket.instances[0].emit({
      type: 'server_notice',
      code: 'transport_disabled',
    })
    await vi.advanceTimersByTimeAsync(30_000)
    await flushPromises()

    // No second socket: the room's refusal outranks a config that has not
    // caught up yet, and polling keeps delivering every committed event.
    expect(ControlledWebSocket.instances).toHaveLength(1)
    expect(statuses).toContain('DO_SUPPRESSED:room_disabled')
    cleanup()
  })

  it('clears the suppression after 5 minutes so a room that started accepting again gets reconnected (#844)', async () => {
    // The app Worker's allowlist can be a wildcard (`*`) that never changes
    // per-streamer, so an operator flipping the room-side allowlist back
    // produces no new configVersion this client can see. Without a TTL the
    // suppression above never clears and the client is stuck on polling
    // until reloaded — observed in preview (issue #844). Matches
    // DO_SUPPRESSION_TTL_MS in src/lib/realtime.ts. It intentionally remains
    // 5 minutes even though the normal config safety refresh is now 10 minutes.
    const SUPPRESSION_TTL_MS = 5 * 60_000

    class ControlledWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly instances: ControlledWebSocket[] = []
      readyState = ControlledWebSocket.CONNECTING
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      onclose: ((event: { code: number }) => void) | null = null

      constructor(readonly url: string) {
        ControlledWebSocket.instances.push(this)
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

    // The app Worker keeps advertising the same do-primary-v1 throughout —
    // standing in for a wildcard allowlist that the operator's room-side
    // flip does not change.
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/realtime-config')) {
        return jsonResponse({
          schemaVersion: 1,
          mode: 'do-primary',
          webSocketUrl: 'https://realtime.example',
          protocolVersion: 1,
          retryPolicy: { baseDelayMs: 100, maxDelayMs: 1_000 },
          configVersion: 'do-primary-v1',
        })
      }
      return jsonResponse({ events: [], realtimeConfigVersion: 'do-primary-v1' })
    }))

    const statuses: string[] = []
    const cleanup = subscribeToGachaResults('ignored', vi.fn(), {
      retryDelay: 3_000,
      onStatusChange: (status) => statuses.push(status),
    })
    await flushPromises()
    expect(ControlledWebSocket.instances).toHaveLength(1)

    ControlledWebSocket.instances[0].emit({
      type: 'server_notice',
      code: 'transport_disabled',
    })
    // Let the transport_disabled handler's own refreshConfig() call settle
    // before advancing the clock, so the TTL and the re-armed safety timer
    // are both anchored to this same instant.
    await flushPromises()
    expect(ControlledWebSocket.instances).toHaveLength(1)
    expect(statuses).toContain('DO_SUPPRESSED:room_disabled')

    // Just under the TTL: still suppressed, no reconnect attempt.
    await vi.advanceTimersByTimeAsync(SUPPRESSION_TTL_MS - 1_000)
    await flushPromises()
    expect(ControlledWebSocket.instances).toHaveLength(1)

    // Crossing the TTL: the next safety-net config refresh clears the
    // suppression and reconnects, standing in for "the operator flipped the
    // room-side allowlist back and the room now accepts this socket".
    await vi.advanceTimersByTimeAsync(2_000)
    await flushPromises()
    expect(ControlledWebSocket.instances).toHaveLength(2)
    cleanup()
  })

  it('falls back to the TTL-gated retry instead of an endless loop when the room keeps refusing the WS upgrade after the TTL fires (#844 review)', async () => {
    // Found in review, not in the original preview run: a room that 503s the
    // WS upgrade fires the browser's onerror+onclose(1006) — indistinguishable
    // from an ordinary transient drop — so without this, once the TTL above
    // clears the suppression, a room that is STILL disabled gets hammered
    // every retryPolicy-backoff interval (~15-30s in production) forever,
    // reproducing the exact reconnect-storm ec6852f fixed. After
    // OPEN_FAILURE_SUPPRESSION_THRESHOLD (3) straight failed opens, the fix
    // falls back to the slow TTL-gated retry the same way an explicit
    // transport_disabled notice does.
    const SUPPRESSION_TTL_MS = 5 * 60_000

    class ControlledWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly instances: ControlledWebSocket[] = []
      // Consumed one per new instance: the next N connection attempts fail
      // to open (onerror+onclose(1006)) instead of succeeding, standing in
      // for a room that keeps 503ing the WS upgrade.
      static failNextOpens = 0
      readyState = ControlledWebSocket.CONNECTING
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      onclose: ((event: { code: number }) => void) | null = null

      constructor(readonly url: string) {
        ControlledWebSocket.instances.push(this)
        if (ControlledWebSocket.failNextOpens > 0) {
          ControlledWebSocket.failNextOpens -= 1
          queueMicrotask(() => {
            this.readyState = 3
            this.onerror?.()
            this.onclose?.({ code: 1006 })
          })
          return
        }
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

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/realtime-config')) {
        return jsonResponse({
          schemaVersion: 1,
          mode: 'do-primary',
          webSocketUrl: 'https://realtime.example',
          protocolVersion: 1,
          retryPolicy: { baseDelayMs: 100, maxDelayMs: 1_000 },
          configVersion: 'do-primary-v1',
        })
      }
      return jsonResponse({ events: [], realtimeConfigVersion: 'do-primary-v1' })
    }))

    const statuses: string[] = []
    const cleanup = subscribeToGachaResults('ignored', vi.fn(), {
      retryDelay: 3_000,
      onStatusChange: (status) => statuses.push(status),
    })
    await flushPromises()
    expect(ControlledWebSocket.instances).toHaveLength(1)

    ControlledWebSocket.instances[0].emit({ type: 'server_notice', code: 'transport_disabled' })
    await flushPromises()
    expect(statuses).toContain('DO_SUPPRESSED:room_disabled')

    // The room is still disabled when the TTL fires: the next 3 connection
    // attempts all fail to open.
    ControlledWebSocket.failNextOpens = 3
    await vi.advanceTimersByTimeAsync(SUPPRESSION_TTL_MS + 1_000)
    await flushPromises()
    // Let the exponential backoff between the 3 failed attempts play out
    // (fast in this test: baseDelayMs 100 / maxDelayMs 1_000).
    await vi.advanceTimersByTimeAsync(10_000)
    await flushPromises()

    // 1 initial connection + 3 failed retries after the TTL, then it stops.
    expect(ControlledWebSocket.instances).toHaveLength(4)
    expect(statuses).toContain('DO_SUPPRESSED:open_failures')

    // Falls back to the slow TTL-gated retry: no new attempts across a
    // stretch that would otherwise contain dozens of exponential-backoff
    // retries (capped at maxDelayMs=1_000 in this test).
    await vi.advanceTimersByTimeAsync(SUPPRESSION_TTL_MS - 2_000)
    await flushPromises()
    expect(ControlledWebSocket.instances).toHaveLength(4)

    // The room finally accepts: the next TTL-gated attempt succeeds.
    await vi.advanceTimersByTimeAsync(3_000)
    await flushPromises()
    expect(ControlledWebSocket.instances).toHaveLength(5)
    expect(statuses).toContain('DO_CONNECTED')
    cleanup()
  })

  it('closes a socket that stops proving liveness and falls back to polling', async () => {
    // A half-open socket looks open to the browser but delivers nothing. With
    // the periodic history pass gone, this deadline is what keeps that from
    // starving the overlay forever.
    class ControlledWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly instances: ControlledWebSocket[] = []
      readyState = ControlledWebSocket.CONNECTING
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      onclose: ((event: { code: number }) => void) | null = null

      constructor(readonly url: string) {
        ControlledWebSocket.instances.push(this)
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

    let historyCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/realtime-config')) {
        return jsonResponse({
          schemaVersion: 1,
          mode: 'do-primary',
          webSocketUrl: 'https://realtime.example',
          protocolVersion: 1,
          retryPolicy: { baseDelayMs: 100, maxDelayMs: 1_000 },
          configVersion: 'do-primary-v1',
        })
      }
      historyCalls += 1
      return jsonResponse({ events: [], realtimeConfigVersion: 'do-primary-v1' })
    }))

    const statuses: string[] = []
    const cleanup = subscribeToGachaResults('ignored', vi.fn(), {
      retryDelay: 3_000,
      onStatusChange: (status) => statuses.push(status),
    })
    await flushPromises()
    const socket = ControlledWebSocket.instances[0]
    socket.emit({ type: 'welcome', protocolVersion: 1, connectionId: 'c1', serverTime: '', seq: 0 })
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    const afterConnect = historyCalls

    // Two heartbeats missed plus slack.
    await vi.advanceTimersByTimeAsync(60_000 * 2.5 + 100)
    await flushPromises()

    expect(statuses).toContain('DO_LIVENESS_TIMEOUT')
    expect(historyCalls).toBeGreaterThan(afterConnect)
    cleanup()
  })

  it('does not refetch the config on every pass while the config endpoint is down', async () => {
    // The safe fallback version never matches what the events endpoint reports,
    // so an ungated comparison would turn every 3-second polling pass into a
    // config refetch — worse than the fixed timer this replaced.
    let configCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/realtime-config')) {
        configCalls += 1
        throw new Error('config endpoint down')
      }
      return jsonResponse({ events: [], realtimeConfigVersion: 'polling-only-v1' })
    }))

    const cleanup = subscribeToGachaResults('ignored', vi.fn(), {
      retryDelay: 3_000,
    })
    await flushPromises()
    const afterStartup = configCalls

    // Ten polling passes at three seconds each.
    await vi.advanceTimersByTimeAsync(30_000)
    await flushPromises()

    // At most one additional attempt per 30-second floor, never one per pass.
    expect(configCalls - afterStartup).toBeLessThanOrEqual(2)
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
    vi.stubGlobal('fetch', vi.fn(async () => {
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
    const fetchMock = vi.fn(async () => jsonResponse({ events: [] }))
    vi.stubGlobal('fetch', fetchMock)

    const cleanup = subscribeToGachaResults('streamer-1', vi.fn(), { retryDelay: 10 })
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledTimes(2)

    cleanup()
    await vi.advanceTimersByTimeAsync(100)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not roll back a disposed controller when a pending display promise settles late', async () => {
    const [event] = buildPollingRealtimeEvents(STREAMER_ID, [{
      id: historyUuid(9_900),
      eventId: 'late-dispose-event',
      redeemedAt: '2026-07-24T00:00:01.000Z',
      userTwitchUsername: 'viewer',
      card: CARD_A,
    }])
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/realtime-config')) {
        return jsonResponse({
          schemaVersion: 1,
          mode: 'polling-only',
          protocolVersion: 1,
          retryPolicy: { baseDelayMs: 10, maxDelayMs: 1_000 },
          configVersion: 'late-dispose-v1',
        })
      }
      return jsonResponse({ realtimeEvents: [event], nextCursor: null })
    }))

    let resolveDisplay!: (accepted: boolean) => void
    const callback = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveDisplay = resolve
    }))
    const statuses: string[] = []
    const onError = vi.fn()
    const cleanup = subscribeToGachaResults('ignored', callback, {
      retryDelay: 10,
      onStatusChange: (status) => statuses.push(status),
      onError,
    })
    await flushPromises()
    expect(callback).toHaveBeenCalledTimes(1)

    cleanup()
    resolveDisplay(false)
    await flushPromises()

    expect(statuses).not.toContain('CALLBACK_ERROR:polling')
    expect(onError).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Overlay card delivery blocked after retry limit' })
    )
  })

  it('does not notify an overlay version from an events request that settles after cleanup', async () => {
    let resolveEvents!: (response: Response) => void
    const pendingEvents = new Promise<Response>((resolve) => {
      resolveEvents = resolve
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/realtime-config')) {
        return jsonResponse({
          schemaVersion: 1,
          mode: 'polling-only',
          protocolVersion: 1,
          retryPolicy: { baseDelayMs: 100, maxDelayMs: 1_000 },
          configVersion: 'polling-v1',
        })
      }
      return pendingEvents
    }))

    const onOverlayVersion = vi.fn()
    const cleanup = subscribeToGachaResults('streamer-1', vi.fn(), {
      onOverlayVersion,
    })
    await flushPromises()

    cleanup()
    resolveEvents(jsonResponse({
      events: [],
      overlayVersion: 'late-build',
    }))
    await flushPromises()

    expect(onOverlayVersion).not.toHaveBeenCalled()
  })
})
