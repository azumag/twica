import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import OverlayPage from '@/app/overlay/[streamerId]/page'
import { buildPollingRealtimeEvents } from '@/lib/overlay-realtime/contract'

vi.mock('next/navigation', () => ({
  useParams: () => ({ streamerId: '123e4567-e89b-42d3-a456-426614174000' }),
}))

class CommitAwareWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static readonly instances: CommitAwareWebSocket[] = []
  readyState = CommitAwareWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null

  constructor(readonly url: string) {
    CommitAwareWebSocket.instances.push(this)
    queueMicrotask(() => {
      this.readyState = CommitAwareWebSocket.OPEN
      this.onopen?.()
    })
  }

  send() {}
  close(code = 1000) {
    this.readyState = CommitAwareWebSocket.CLOSED
    this.onclose?.({ code })
  }
  emit(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
}

describe('OverlayPage actual realtime transport commit acknowledgement', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    CommitAwareWebSocket.instances.length = 0
    sessionStorage.clear()
  })

  it('Fake WebSocket payload is acknowledged only after card DOM and img commit', async () => {
    vi.stubGlobal('WebSocket', CommitAwareWebSocket)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/realtime-config')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            schemaVersion: 1,
            mode: 'do-primary',
            webSocketUrl: 'https://realtime.example',
            protocolVersion: 1,
            retryPolicy: { baseDelayMs: 100, maxDelayMs: 1_000 },
            configVersion: 'commit-aware-v1',
          }),
        } as Response
      }
      if (url.includes('/events')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ realtimeEvents: [], nextCursor: null }),
        } as Response
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ soundUrl: null, soundEnabled: false }),
      } as Response
    }))
    class PendingImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_value: string) {}
    }
    vi.stubGlobal('Image', PendingImage)

    render(<OverlayPage />)
    await waitFor(() => expect(CommitAwareWebSocket.instances).toHaveLength(1))
    const socket = CommitAwareWebSocket.instances[0]
    const streamerId = '123e4567-e89b-42d3-a456-426614174000'
    const [event] = buildPollingRealtimeEvents(streamerId, [{
      id: '00000000-0000-4000-8000-000000000201',
      eventId: 'commit-aware-event',
      redeemedAt: '2026-07-24T00:00:01.000Z',
      userTwitchUsername: 'Viewer',
      rewardId: 'reward-1',
      card: {
        id: 'commit-aware-card',
        name: 'Commit Aware Card',
        description: null,
        image_url: 'https://example.com/commit-aware.png',
        rarity: 'common',
        },
      }])
    const seenStorageKey = `twica:overlay-seen:v1:${streamerId}`
    await act(async () => {
      socket.emit({
        type: 'welcome',
        protocolVersion: 1,
        connectionId: 'commit-aware-connection',
        serverTime: '',
        seq: 0,
      })
      socket.emit({ type: 'gacha_result', seq: 1, event })
      // The transport must not persist the event ID until the React commit
      // acknowledgement has observed the card branch and image element.
      expect(sessionStorage.getItem(seenStorageKey)).toBeNull()
      await Promise.resolve()
    })

    await waitFor(() => {
      const root = document.querySelector('[data-overlay-card="true"]')
      expect(root).not.toBeNull()
      expect(root?.querySelector('img')).not.toBeNull()
      expect(root?.querySelector('img')?.getAttribute('loading')).toBe('eager')
      expect(screen.getByText('Commit Aware Card')).toBeInTheDocument()
    })
    const image = document.querySelector('[data-overlay-card="true"] img') as HTMLImageElement
    Object.defineProperty(image, 'complete', { configurable: true, value: true })
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 320 })
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 448 })
    await act(async () => {
      image.dispatchEvent(new Event('load'))
      await Promise.resolve()
    })
    const seenRecords = JSON.parse(sessionStorage.getItem(seenStorageKey) ?? '[]') as Array<[string, number]>
    expect(seenRecords.map(([eventId]) => eventId)).toContain(event.draws[0].eventId)
  })
})
