import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), sql: vi.fn() }))
vi.mock('@/lib/db/client', () => ({ getDb: mocks.getDb }))
vi.mock('@/lib/db/retry', () => ({
  withDbRetry: async <T>(fn: () => Promise<T>) => fn(),
}))
import { resolveChatNotificationDeliveryMode } from '@/lib/services/chat-notification-congestion'

const claim = {
  id: '11111111-1111-4111-8111-111111111111',
  leaseId: '22222222-2222-4222-8222-222222222222',
}

describe('resolveChatNotificationDeliveryMode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getDb.mockResolvedValue({ sql: mocks.sql })
  })

  it.each(['summary', 'individual', 'chunked'] as const)('uses the persisted %s decision from the fenced RPC', async (mode) => {
    mocks.sql.mockResolvedValue([{ mode }])
    await expect(resolveChatNotificationDeliveryMode(claim)).resolves.toBe(mode)
    const [strings, ...values] = mocks.sql.mock.calls[0] as [TemplateStringsArray, ...unknown[]]
    expect(strings.join('?')).toContain('public.resolve_chat_outbox_delivery_mode')
    expect(values).toEqual([claim.id, claim.leaseId])
  })

  it.each([[{ mode: null }], [], [{ mode: 'unknown' }]])('fails closed on lost lease or invalid response %j', async (...rows) => {
    mocks.sql.mockResolvedValue(rows)
    await expect(resolveChatNotificationDeliveryMode(claim)).resolves.toBeNull()
  })

  it('does not turn database failure into permission to send', async () => {
    mocks.sql.mockRejectedValue(new Error('database unavailable'))
    await expect(resolveChatNotificationDeliveryMode(claim)).rejects.toThrow('database unavailable')
  })
})
