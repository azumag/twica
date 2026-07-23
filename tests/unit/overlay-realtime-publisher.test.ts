import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDb } from '@/lib/db/client'
import { verifyPublishSignature } from '@/lib/overlay-realtime/signature'

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

function configureCommittedRows() {
  const rows = [
    {
      id: 'history-1',
      eventId: 'batch-1',
      redeemedAt: '2026-07-24T00:00:00.000Z',
    },
    {
      id: 'history-2',
      eventId: 'batch-1:2',
      redeemedAt: '2026-07-24T00:00:00.000Z',
    },
  ]
  const query = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  }
  vi.mocked(getDb).mockResolvedValue({
    db: { select: vi.fn(() => query) },
    sql: {},
  } as never)
}

describe('publishCommittedGachaBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.OVERLAY_REALTIME_MODE = 'do-primary'
    process.env.OVERLAY_REALTIME_STREAMER_ALLOWLIST = STREAMER_ID
    process.env.OVERLAY_REALTIME_PUBLISH_URL =
      'https://twica-overlay-realtime-preview.example.workers.dev'
    process.env.OVERLAY_REALTIME_PUBLISH_SECRET = 'publisher-test-secret'
    configureCommittedRows()
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
    vi.unstubAllGlobals()
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
})
