import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getCloudflareContext } from '@opennextjs/cloudflare'

vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: vi.fn(),
}))
vi.mock('@/lib/logger.server', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/services/chat-notification-outbox', () => ({
  reserveDueChatNotificationOutboxForWake: vi.fn(),
}))

import {
  dispatchDueChatNotifications,
  enqueueChatNotificationWakeup,
} from '@/lib/services/chat-notification-dispatch'
import { reserveDueChatNotificationOutboxForWake } from '@/lib/services/chat-notification-outbox'

const mockReserve = vi.mocked(reserveDueChatNotificationOutboxForWake)

describe('chat-notification-dispatch (Issue #1665)', () => {
  const originalEnv = process.env.CHAT_DELIVERY_DISPATCH_ENABLED
  const originalNodeEnv = process.env.NODE_ENV

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.CHAT_DELIVERY_DISPATCH_ENABLED
    // NODE_ENVを明示的にtestへ固定し、getDispatchEnvironmentのproduction fail-closed
    // 分岐(このテストの対象外)に迷い込まないようにする。
    vi.stubEnv('NODE_ENV', 'test')
    // 何もmockしていないデフォルト状態では、getCloudflareContext()自体が
    // Workersリクエストコンテキスト無しでrejectする（next dev/Vitestの実態）。
    vi.mocked(getCloudflareContext).mockRejectedValue(
      new Error('Cloudflare request context is unavailable in unit tests'),
    )
  })

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CHAT_DELIVERY_DISPATCH_ENABLED
    else process.env.CHAT_DELIVERY_DISPATCH_ENABLED = originalEnv
    vi.stubEnv('NODE_ENV', originalNodeEnv ?? 'test')
    vi.unstubAllEnvs()
  })

  describe('new dispatch path defaults to disabled (Issue #1665 rollout: 新経路は初期無効)', () => {
    it('enqueueChatNotificationWakeup no-ops as disabled and never touches the queue', async () => {
      await expect(enqueueChatNotificationWakeup('batch-1')).resolves.toEqual({ outcome: 'disabled' })
    })

    it('dispatchDueChatNotifications no-ops as disabled without reserving any rows', async () => {
      await expect(dispatchDueChatNotifications(25, 120)).resolves.toEqual({
        reserved: 0,
        enqueued: 0,
        skippedDisabled: true,
      })
      expect(mockReserve).not.toHaveBeenCalled()
    })
  })

  describe('when the flag is enabled but the Queue binding does not exist yet', () => {
    beforeEach(() => {
      process.env.CHAT_DELIVERY_DISPATCH_ENABLED = 'true'
    })

    it('enqueueChatNotificationWakeup reports queue-binding-missing without throwing', async () => {
      await expect(enqueueChatNotificationWakeup('batch-1')).resolves.toEqual({
        outcome: 'unavailable',
        reason: 'queue-binding-missing',
      })
    })

    it('dispatchDueChatNotifications still reserves rows (DB state is independent of the queue) but cannot enqueue them', async () => {
      mockReserve.mockResolvedValue([
        { id: 'row-1', batchId: 'batch-1' },
        { id: 'row-2', batchId: 'batch-2' },
      ])

      await expect(dispatchDueChatNotifications(25, 120)).resolves.toEqual({
        reserved: 2,
        enqueued: 0,
        skippedDisabled: false,
      })
      expect(mockReserve).toHaveBeenCalledWith(25, 120)
    })
  })

  describe('when running inside a Workers request context', () => {
    it('enqueues onto the bound Queue producer when the flag is enabled', async () => {
      const send = vi.fn().mockResolvedValue(undefined)
      vi.mocked(getCloudflareContext).mockResolvedValue({
        env: {
          CHAT_DELIVERY_DISPATCH_ENABLED: 'true',
          CHAT_NOTIFICATION_QUEUE: { send },
        },
      } as never)

      await expect(enqueueChatNotificationWakeup('batch-1')).resolves.toEqual({ outcome: 'enqueued' })
      expect(send).toHaveBeenCalledWith({ version: 1, batchId: 'batch-1' })
    })

    it('is disabled when the Workers env omits the truthy flag', async () => {
      const send = vi.fn()
      vi.mocked(getCloudflareContext).mockResolvedValue({
        env: { CHAT_NOTIFICATION_QUEUE: { send } },
      } as never)

      await expect(enqueueChatNotificationWakeup('batch-1')).resolves.toEqual({ outcome: 'disabled' })
      expect(send).not.toHaveBeenCalled()
    })

    it('reports unavailable and never throws when send() itself rejects', async () => {
      const send = vi.fn().mockRejectedValue(new Error('queue unavailable'))
      vi.mocked(getCloudflareContext).mockResolvedValue({
        env: {
          CHAT_DELIVERY_DISPATCH_ENABLED: '1',
          CHAT_NOTIFICATION_QUEUE: { send },
        },
      } as never)

      await expect(enqueueChatNotificationWakeup('batch-1')).resolves.toEqual({
        outcome: 'unavailable',
        reason: 'enqueue-failed',
      })
    })

    it('dispatchDueChatNotifications enqueues each reserved row independently and counts only successes', async () => {
      const send = vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('transient'))
      vi.mocked(getCloudflareContext).mockResolvedValue({
        env: {
          CHAT_DELIVERY_DISPATCH_ENABLED: 'true',
          CHAT_NOTIFICATION_QUEUE: { send },
        },
      } as never)
      mockReserve.mockResolvedValue([
        { id: 'row-1', batchId: 'batch-1' },
        { id: 'row-2', batchId: 'batch-2' },
      ])

      await expect(dispatchDueChatNotifications(25, 120)).resolves.toEqual({
        reserved: 2,
        enqueued: 1,
        skippedDisabled: false,
      })
      expect(send).toHaveBeenCalledTimes(2)
    })
  })
})
