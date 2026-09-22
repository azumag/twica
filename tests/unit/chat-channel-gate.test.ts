import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), sql: vi.fn() }))
vi.mock('@/lib/db/client', () => ({ getDb: mocks.getDb }))
vi.mock('@/lib/db/retry', () => ({
  withDbRetry: async <T>(fn: () => Promise<T>) => fn(),
}))
import { reserveChatChannelSendSlot } from '@/lib/services/chat-channel-gate'

describe('reserveChatChannelSendSlot', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getDb.mockResolvedValue({ sql: mocks.sql })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('calls reserve_chat_channel_send_slot with the broadcaster id and interval', async () => {
    mocks.sql.mockResolvedValueOnce([{ reserved: true, wait_until: '2026-09-22T00:00:00.000Z' }])

    await reserveChatChannelSendSlot('broadcaster-1', {
      intervalMs: 1600,
      deadlineAt: Date.now() + 1_000,
    })

    const [strings, ...values] = mocks.sql.mock.calls[0] as [TemplateStringsArray, ...unknown[]]
    expect(strings.join('?')).toContain('reserve_chat_channel_send_slot')
    expect(values).toEqual(['broadcaster-1', 1600])
  })

  it('reserves immediately when the slot is free, without waiting', async () => {
    mocks.sql.mockResolvedValueOnce([{ reserved: true, wait_until: '2026-09-22T00:00:00.000Z' }])
    const delay = vi.fn()

    await expect(reserveChatChannelSendSlot('broadcaster-1', {
      intervalMs: 1600,
      deadlineAt: Date.now() + 60_000,
      delay,
    })).resolves.toEqual({ outcome: 'reserved' })

    expect(delay).not.toHaveBeenCalled()
  })

  it('waits for wait_until and retries once the slot frees up', async () => {
    vi.useFakeTimers()
    const start = new Date('2026-09-22T00:00:00.000Z')
    vi.setSystemTime(start)

    mocks.sql
      .mockResolvedValueOnce([{ reserved: false, wait_until: '2026-09-22T00:00:01.000Z' }])
      .mockResolvedValueOnce([{ reserved: true, wait_until: '2026-09-22T00:00:01.000Z' }])

    const delay = vi.fn().mockImplementation(async (ms: number) => {
      vi.setSystemTime(new Date(Date.now() + ms))
    })

    const outcome = await reserveChatChannelSendSlot('broadcaster-1', {
      intervalMs: 1600,
      deadlineAt: start.getTime() + 60_000,
      delay,
    })

    expect(outcome).toEqual({ outcome: 'reserved' })
    expect(delay).toHaveBeenCalledTimes(1)
    expect(delay.mock.calls[0]?.[0]).toBe(1_000)
    expect(mocks.sql).toHaveBeenCalledTimes(2)
  })

  it('gives up as budget-exhausted once the deadline passes while waiting', async () => {
    vi.useFakeTimers()
    const start = new Date('2026-09-22T00:00:00.000Z')
    vi.setSystemTime(start)

    // wait_untilは10分先だが、予算は500msしか残っていない。
    mocks.sql.mockResolvedValue([{ reserved: false, wait_until: '2026-09-22T00:10:00.000Z' }])
    const delay = vi.fn().mockImplementation(async (ms: number) => {
      vi.setSystemTime(new Date(Date.now() + ms))
    })

    const outcome = await reserveChatChannelSendSlot('broadcaster-1', {
      intervalMs: 1600,
      deadlineAt: start.getTime() + 500,
      delay,
    })

    expect(outcome).toEqual({ outcome: 'budget-exhausted' })
    expect(mocks.sql).toHaveBeenCalledTimes(1)
    // 予算を超えて待たせない: 実際のwait_untilまでの600秒ではなく、
    // 残り予算(500ms)にクランプして待つ。
    expect(delay.mock.calls[0]?.[0]).toBe(500)
  })

  it('returns budget-exhausted immediately when the deadline has already passed', async () => {
    const outcome = await reserveChatChannelSendSlot('broadcaster-1', {
      intervalMs: 1600,
      deadlineAt: Date.now() - 1,
    })

    expect(outcome).toEqual({ outcome: 'budget-exhausted' })
    expect(mocks.sql).not.toHaveBeenCalled()
  })
})
