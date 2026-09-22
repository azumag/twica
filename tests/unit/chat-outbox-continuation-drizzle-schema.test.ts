import { getTableColumns } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  chatChannelSendGate,
  chatNotificationOutbox,
} from '@/lib/db/schema'

describe('chat outbox continuation and channel gate Drizzle schema', () => {
  it('outboxのpending_kind/wake_reserved_until列をmigrationと同じ制約で型付けする', () => {
    const columns = getTableColumns(chatNotificationOutbox)

    expect(Object.keys(columns)).toEqual(
      expect.arrayContaining(['pending_kind', 'wake_reserved_until']),
    )
    expect(columns.pending_kind.notNull).toBe(true)
    expect(columns.pending_kind.hasDefault).toBe(true)
    // wake_reserved_untilはmigrationでNOT NULLを付けていない(NULL許容)ため、
    // notNullはfalseのまま型付けする。
    expect(columns.wake_reserved_until.notNull).toBe(false)
  })

  it('チャネル単位の送信間隔gateテーブルをmigrationと同じ列で型付けする', () => {
    const columns = getTableColumns(chatChannelSendGate)

    expect(Object.keys(columns)).toEqual([
      'broadcaster_twitch_user_id',
      'next_send_at',
      'updated_at',
    ])
    expect(columns.broadcaster_twitch_user_id.primary).toBe(true)
    expect(columns.next_send_at.notNull).toBe(true)
    expect(columns.next_send_at.hasDefault).toBe(true)
    expect(columns.updated_at.notNull).toBe(true)
    expect(columns.updated_at.hasDefault).toBe(true)
  })
})
