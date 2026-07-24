import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getCloudflareContext } from '@opennextjs/cloudflare'
import { getDb } from '@/lib/db/client'
import { verifyPublishSignature } from '@/lib/overlay-realtime/signature'

vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { publishCommittedGachaBatch } from '@/lib/overlay-realtime/publisher'

const STREAMER_ID = '123e4567-e89b-42d3-a456-426614174000'
const ORIGINAL_ENV = { ...process.env }

function configureCommittedRows(drawCount = 2) {
  const rows = Array.from({ length: drawCount }, (_, index) => ({
    id: `history-${index + 1}`,
    eventId: index === 0 ? 'batch-1' : `batch-1:${index + 1}`,
    redeemedAt: '2026-07-24T00:00:00.000Z',
  }))
  const query = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  }
  vi.mocked(getDb).mockResolvedValue({
    db: { select: vi.fn(() => query) },
    sql: {},
  } as never)
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve()
  }
}

describe('publishCommittedGachaBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getCloudflareContext).mockRejectedValue(
      new Error('Cloudflare request context is unavailable in unit tests')
    )
    process.env.OVERLAY_REALTIME_MODE = 'do-primary'
    process.env.OVERLAY_REALTIME_STREAMER_ALLOWLIST = STREAMER_ID
    process.env.OVERLAY_REALTIME_PUBLISH_URL =
      'https://twica-overlay-realtime-preview.example.workers.dev'
    process.env.OVERLAY_REALTIME_PUBLISH_SECRET = 'publisher-test-secret'
    configureCommittedRows()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    process.env = { ...ORIGINAL_ENV }
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('rebuilds stable draw identity from committed rows and signs the request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ accepted: true }, { status: 202 })
    )
    vi.stubGlobal('fetch', fetchMock)
    const cards = [
      {
        id: 'card-1',
        name: 'Card 1',
        description: null,
        image_url: null,
        rarity: 'common',
      },
      {
        id: 'card-2',
        name: 'Card 2',
        description: null,
        image_url: null,
        rarity: 'rare',
      },
    ]

    await expect(
      publishCommittedGachaBatch(
        STREAMER_ID,
        {
          card: cards[0],
          cards,
          userTwitchUsername: 'viewer',
          rewardId: 'reward-1',
        },
        { batchId: 'batch-1' }
      )
    ).resolves.toEqual({ outcome: 'accepted', attempts: 1 })

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit]
    const body = String(init.body)
    const event = JSON.parse(body)
    expect(event.draws.map((draw: { eventId: string; historyId: string }) => ({
      eventId: draw.eventId,
      historyId: draw.historyId,
    }))).toEqual([
      { eventId: 'batch-1', historyId: 'history-1' },
      { eventId: 'batch-1:2', historyId: 'history-2' },
    ])
    const headers = init.headers as Record<string, string>
    await expect(
      verifyPublishSignature(
        process.env.OVERLAY_REALTIME_PUBLISH_SECRET!,
        url.pathname,
        body,
        headers['x-twica-timestamp'],
        headers['x-twica-nonce'],
        headers['x-twica-signature']
      )
    ).resolves.toBe(true)
  })

  it('prefers rotated Workers runtime secrets over build-time process values', async () => {
    vi.mocked(getCloudflareContext).mockResolvedValue({
      env: {
        OVERLAY_REALTIME_MODE: 'do-primary',
        OVERLAY_REALTIME_STREAMER_ALLOWLIST: STREAMER_ID,
        OVERLAY_REALTIME_PUBLISH_URL:
          'https://runtime-overlay-realtime.example.workers.dev',
        OVERLAY_REALTIME_PUBLISH_SECRET: 'rotated-runtime-secret',
      },
    } as never)
    process.env.OVERLAY_REALTIME_PUBLISH_URL =
      'https://stale-build-value.example.workers.dev'
    process.env.OVERLAY_REALTIME_PUBLISH_SECRET = 'stale-build-secret'
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ accepted: true }, { status: 202 })
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      publishCommittedGachaBatch(
        STREAMER_ID,
        {
          card: {
            id: 'card-1',
            name: 'Card',
            description: null,
            image_url: null,
            rarity: 'common',
          },
          userTwitchUsername: 'viewer',
        },
        { batchId: 'batch-1' }
      )
    ).resolves.toEqual({ outcome: 'accepted', attempts: 1 })

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit]
    expect(url.hostname).toBe('runtime-overlay-realtime.example.workers.dev')
    const headers = init.headers as Record<string, string>
    await expect(
      verifyPublishSignature(
        'rotated-runtime-secret',
        url.pathname,
        String(init.body),
        headers['x-twica-timestamp'],
        headers['x-twica-nonce'],
        headers['x-twica-signature']
      )
    ).resolves.toBe(true)
  })

  it('does not mix missing Workers bindings with stale process values', async () => {
    vi.mocked(getCloudflareContext).mockResolvedValue({ env: {} } as never)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      publishCommittedGachaBatch(
        STREAMER_ID,
        {
          card: {
            id: 'card-1',
            name: 'Card',
            description: null,
            image_url: null,
            rarity: 'common',
          },
          userTwitchUsername: 'viewer',
        },
        { batchId: 'batch-1' }
      )
    ).resolves.toEqual({
      outcome: 'skipped',
      attempts: 0,
      errorCode: 'mode-disabled',
    })
    expect(getDb).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails closed when a Workers publisher credential is missing', async () => {
    vi.mocked(getCloudflareContext).mockResolvedValue({
      env: {
        OVERLAY_REALTIME_MODE: 'do-primary',
        OVERLAY_REALTIME_STREAMER_ALLOWLIST: STREAMER_ID,
        OVERLAY_REALTIME_PUBLISH_URL:
          'https://runtime-overlay-realtime.example.workers.dev',
      },
    } as never)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      publishCommittedGachaBatch(
        STREAMER_ID,
        {
          card: {
            id: 'card-1',
            name: 'Card',
            description: null,
            image_url: null,
            rarity: 'common',
          },
          userTwitchUsername: 'viewer',
        },
        { batchId: 'batch-1' }
      )
    ).resolves.toEqual({
      outcome: 'skipped',
      attempts: 0,
      errorCode: 'configuration-missing',
    })
    expect(getDb).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('honors the Workers polling-only kill switch over stale process mode', async () => {
    vi.mocked(getCloudflareContext).mockResolvedValue({
      env: {
        OVERLAY_REALTIME_MODE: 'polling-only',
        OVERLAY_REALTIME_STREAMER_ALLOWLIST: STREAMER_ID,
        OVERLAY_REALTIME_PUBLISH_URL:
          'https://runtime-overlay-realtime.example.workers.dev',
        OVERLAY_REALTIME_PUBLISH_SECRET: 'rotated-runtime-secret',
      },
    } as never)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      publishCommittedGachaBatch(
        STREAMER_ID,
        {
          card: {
            id: 'card-1',
            name: 'Card',
            description: null,
            image_url: null,
            rarity: 'common',
          },
          userTwitchUsername: 'viewer',
        },
        { batchId: 'batch-1' }
      )
    ).resolves.toEqual({
      outcome: 'skipped',
      attempts: 0,
      errorCode: 'mode-disabled',
    })
    expect(getDb).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails closed when the production Workers context cannot be read', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      publishCommittedGachaBatch(
        STREAMER_ID,
        {
          card: {
            id: 'card-1',
            name: 'Card',
            description: null,
            image_url: null,
            rarity: 'common',
          },
          userTwitchUsername: 'viewer',
        },
        { batchId: 'batch-1' }
      )
    ).resolves.toEqual({
      outcome: 'skipped',
      attempts: 0,
      errorCode: 'mode-disabled',
    })
    expect(getDb).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does no database or network work behind the polling-only kill switch', async () => {
    process.env.OVERLAY_REALTIME_MODE = 'polling-only'
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      publishCommittedGachaBatch(
        STREAMER_ID,
        {
          card: {
            id: 'card-1',
            name: 'Card',
            description: null,
            image_url: null,
            rarity: 'common',
          },
          userTwitchUsername: 'viewer',
        },
        { batchId: 'batch-1' }
      )
    ).resolves.toEqual({
      outcome: 'skipped',
      attempts: 0,
      errorCode: 'mode-disabled',
    })
    expect(getDb).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never changes a committed draw into a caller failure when identity re-read fails', async () => {
    vi.mocked(getDb).mockRejectedValue(new Error('temporary PlanetScale failure'))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      publishCommittedGachaBatch(
        STREAMER_ID,
        {
          card: {
            id: 'card-1',
            name: 'Card',
            description: null,
            image_url: null,
            rarity: 'common',
          },
          userTwitchUsername: 'viewer',
        },
        { batchId: 'batch-1' }
      )
    ).resolves.toEqual({
      outcome: 'failed',
      attempts: 0,
      errorCode: 'unexpected',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('retries a transient 5xx once with a newly signed request', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    let firstAttemptStarted!: () => void
    const firstAttempt = new Promise<void>((resolve) => {
      firstAttemptStarted = resolve
    })
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => {
        firstAttemptStarted()
        return Response.json({}, { status: 503 })
      })
      .mockResolvedValueOnce(Response.json({ accepted: true }, { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)

    const resultPromise = publishCommittedGachaBatch(
      STREAMER_ID,
      {
        card: {
          id: 'card-1',
          name: 'Card',
          description: null,
          image_url: null,
          rarity: 'common',
        },
        userTwitchUsername: 'viewer',
      },
      { batchId: 'batch-1', maxRetries: 1, retryDelay: 50 }
    )
    await firstAttempt
    await flushPromises()
    await vi.advanceTimersByTimeAsync(50)

    await expect(resultPromise).resolves.toEqual({
      outcome: 'accepted',
      attempts: 2,
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const firstHeaders = fetchMock.mock.calls[0][1].headers as Record<string, string>
    const retryHeaders = fetchMock.mock.calls[1][1].headers as Record<string, string>
    expect(retryHeaders['x-twica-nonce']).not.toBe(
      firstHeaders['x-twica-nonce']
    )
  })

  it('does not retry a non-retryable 4xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({}, { status: 401 })
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      publishCommittedGachaBatch(
        STREAMER_ID,
        {
          card: {
            id: 'card-1',
            name: 'Card',
            description: null,
            image_url: null,
            rarity: 'common',
          },
          userTwitchUsername: 'viewer',
        },
        { batchId: 'batch-1', maxRetries: 2 }
      )
    ).resolves.toEqual({
      outcome: 'failed',
      attempts: 1,
      errorCode: 'http-401',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('aborts timed-out attempts and stops after the bounded retry', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    let firstAttemptStarted!: () => void
    let secondAttemptStarted!: () => void
    const firstAttempt = new Promise<void>((resolve) => {
      firstAttemptStarted = resolve
    })
    const secondAttempt = new Promise<void>((resolve) => {
      secondAttemptStarted = resolve
    })
    let attemptCount = 0
    const fetchMock = vi.fn(
      (_url: URL, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        attemptCount += 1
        if (attemptCount === 1) {
          firstAttemptStarted()
        } else {
          secondAttemptStarted()
        }
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const resultPromise = publishCommittedGachaBatch(
      STREAMER_ID,
      {
        card: {
          id: 'card-1',
          name: 'Card',
          description: null,
          image_url: null,
          rarity: 'common',
        },
        userTwitchUsername: 'viewer',
      },
      { batchId: 'batch-1', maxRetries: 1, retryDelay: 50 }
    )

    // Envelope rebuilding and WebCrypto signing are asynchronous and happen
    // before the timeout is registered. Wait for each fetch attempt to start,
    // then advance only that attempt's 1.5-second deadline. This avoids moving
    // fake time before the code under test has installed its timer.
    await firstAttempt
    await vi.advanceTimersByTimeAsync(1_500)
    await vi.advanceTimersByTimeAsync(50)
    await secondAttempt
    await vi.advanceTimersByTimeAsync(1_500)

    await expect(resultPromise).resolves.toEqual({
      outcome: 'failed',
      attempts: 2,
      errorCode: 'network',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('skips an escaped payload that exceeds the byte contract', async () => {
    configureCommittedRows(15)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const cards = Array.from({ length: 15 }, (_, index) => ({
      id: `card-${index + 1}`,
      name: 'Card',
      description: '\u0000'.repeat(1_024),
      image_url: '\u0000'.repeat(2_048),
      rarity: 'common',
    }))

    await expect(
      publishCommittedGachaBatch(
        STREAMER_ID,
        {
          card: cards[0],
          cards,
          userTwitchUsername: 'viewer',
        },
        { batchId: 'batch-1' }
      )
    ).resolves.toEqual({
      outcome: 'skipped',
      attempts: 0,
      errorCode: 'identity-unavailable',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
