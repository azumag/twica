import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  sql: vi.fn(),
}))

vi.mock('@/lib/db/client', () => ({ getDb: mocks.getDb }))
vi.mock('@/lib/db/retry', () => ({
  withDbRetry: async <T>(fn: () => Promise<T>) => fn(),
}))

import { hasOlderPacedChatNotification } from '@/lib/services/chat-notification-congestion'

const claim = {
  id: '11111111-1111-4111-8111-111111111111',
  createdAt: '2026-09-12T00:00:01.000Z',
}

describe('hasOlderPacedChatNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getDb.mockResolvedValue({ sql: mocks.sql })
  })

  it('returns true when an older paced row is still pending/processing', async () => {
    mocks.sql.mockResolvedValue([{ busy: true }])

    await expect(hasOlderPacedChatNotification(claim, 'streamer-1')).resolves.toBe(true)

    const [strings, ...values] = mocks.sql.mock.calls[0] as [TemplateStringsArray, ...unknown[]]
    const query = strings.join('?')
    expect(query).toContain("older.status in ('pending', 'processing')")
    expect(query).toContain("older.delivery_mode in ('individual', 'chunked')")
    expect(query).toContain("older.payload #>> '{streamer,id}'")
    expect(query).toContain('older.created_at <')
    expect(query).toContain('older.id::text <')
    expect(values).toContain(claim.id)
    expect(values).toContain(claim.createdAt)
    expect(values).toContain('streamer-1')
  })

  it('returns false when the channel has no older paced row', async () => {
    mocks.sql.mockResolvedValue([{ busy: false }])
    await expect(hasOlderPacedChatNotification(claim, 'streamer-1')).resolves.toBe(false)
  })

  it('fails closed to no pacing decision when the query shape is unexpectedly empty', async () => {
    mocks.sql.mockResolvedValue([])
    await expect(hasOlderPacedChatNotification(claim, 'streamer-1')).resolves.toBe(false)
  })
})
