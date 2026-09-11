import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDb } from '@/lib/db/client'
import { users as usersTable } from '@/lib/db/schema'
import { getChannelPointsAccessState } from '@/lib/twitch/channel-points-access'

const mockGetDb = vi.mocked(getDb)
type DbHandle = Awaited<ReturnType<typeof getDb>>

describe('getChannelPointsAccessState table contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('usersTable 以外を SELECT した場合は fixture が fail-fast する', async () => {
    const limit = vi.fn().mockResolvedValue([
      {
        capability: 'available',
        checkedAt: '2026-09-12T00:00:00.000Z',
        enabled: true,
      },
    ])
    const where = vi.fn(() => ({ limit }))
    const from = vi.fn((table: unknown) => {
      if (table !== usersTable) {
        throw new Error('unexpected channel-points access table')
      }
      return { where }
    })
    const select = vi.fn(() => ({ from }))

    mockGetDb.mockResolvedValue({
      db: { select } as unknown as DbHandle['db'],
      sql: {} as unknown as DbHandle['sql'],
    })

    await expect(getChannelPointsAccessState('twitch-user-table-contract')).resolves.toEqual({
      capability: 'available',
      checkedAt: '2026-09-12T00:00:00.000Z',
      enabled: true,
    })
    expect(from).toHaveBeenCalledWith(usersTable)
    expect(limit).toHaveBeenCalledWith(1)
  })
})
