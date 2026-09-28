import { beforeEach, describe, expect, it, vi } from 'vitest'

const getMaintenanceKvBindingMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/maintenance/eventsub-park', () => ({
  getMaintenanceKvBinding: getMaintenanceKvBindingMock,
}))

import {
  isDuplicateEventSubMessage,
  markEventSubMessageSeen,
} from '@/lib/eventsub-dedup'

describe('eventsub dedup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('treats an empty message id as unknown without touching KV', async () => {
    await expect(isDuplicateEventSubMessage('')).resolves.toBe(false)
    await expect(markEventSubMessageSeen('')).resolves.toBeUndefined()
    expect(getMaintenanceKvBindingMock).not.toHaveBeenCalled()
  })

  it('fails open when the KV binding is unavailable', async () => {
    getMaintenanceKvBindingMock.mockResolvedValue(null)

    await expect(isDuplicateEventSubMessage('message-1')).resolves.toBe(false)
    await expect(markEventSubMessageSeen('message-1')).resolves.toBeUndefined()
  })

  it('only treats a message as duplicate when KV already contains the key', async () => {
    const get = vi.fn()
    const binding = { get, put: vi.fn(), delete: vi.fn() }
    getMaintenanceKvBindingMock.mockResolvedValue(binding)

    get.mockResolvedValueOnce(null)
    await expect(isDuplicateEventSubMessage('message-2')).resolves.toBe(false)
    expect(get).toHaveBeenLastCalledWith('eventsub:dedup:message-2')

    get.mockResolvedValueOnce('1')
    await expect(isDuplicateEventSubMessage('message-2')).resolves.toBe(true)
  })

  it('fails open when reading the dedup key throws', async () => {
    const get = vi.fn().mockRejectedValue(new Error('KV unavailable'))
    getMaintenanceKvBindingMock.mockResolvedValue({ get, put: vi.fn(), delete: vi.fn() })

    await expect(isDuplicateEventSubMessage('message-3')).resolves.toBe(false)
  })

  it('records the message id with the 10 minute EventSub replay TTL', async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    getMaintenanceKvBindingMock.mockResolvedValue({ get: vi.fn(), put, delete: vi.fn() })

    await expect(markEventSubMessageSeen('message-4')).resolves.toBeUndefined()
    expect(put).toHaveBeenCalledWith(
      'eventsub:dedup:message-4',
      '1',
      { expirationTtl: 600 },
    )
  })

  it('does not leak KV write failures to the EventSub request path', async () => {
    const put = vi.fn().mockRejectedValue(new Error('KV write failed'))
    getMaintenanceKvBindingMock.mockResolvedValue({ get: vi.fn(), put, delete: vi.fn() })

    await expect(markEventSubMessageSeen('message-5')).resolves.toBeUndefined()
  })
})
