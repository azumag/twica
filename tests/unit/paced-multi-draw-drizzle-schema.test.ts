import { getTableColumns } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  chatNotificationOutbox,
  streamerChatMultiDeliverySettings,
} from '@/lib/db/schema'

describe('paced multi-draw Drizzle schema', () => {
  it('配信者ごとの配送設定テーブルをmigrationと同じ列で型付けする', () => {
    const columns = getTableColumns(streamerChatMultiDeliverySettings)

    expect(Object.keys(columns)).toEqual([
      'streamer_id',
      'delivery_mode',
      'chunk_size',
      'created_at',
      'updated_at',
    ])
    expect(columns.streamer_id.primary).toBe(true)
    expect(columns.delivery_mode.notNull).toBe(true)
    expect(columns.delivery_mode.hasDefault).toBe(true)
    expect(columns.chunk_size.notNull).toBe(true)
    expect(columns.chunk_size.hasDefault).toBe(true)
  })

  it('outboxの分割配送snapshot/cursor列を型付けする', () => {
    const columns = getTableColumns(chatNotificationOutbox)

    expect(Object.keys(columns)).toEqual(
      expect.arrayContaining([
        'delivery_mode',
        'delivery_chunk_size',
        'delivery_cursor',
        'delivery_mode_resolved',
      ])
    )
    for (const name of [
      'delivery_mode',
      'delivery_chunk_size',
      'delivery_cursor',
      'delivery_mode_resolved',
    ] as const) {
      expect(columns[name].notNull).toBe(true)
      expect(columns[name].hasDefault).toBe(true)
    }
  })
})
